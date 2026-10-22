#!/usr/bin/env bash
# Build the espressif/qemu fork into .qemu/: qemu-system-xtensa (esp32s3) and
# qemu-system-riscv32 (esp32c6).
# Idempotent: skips if both binaries already work with the current patch set.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
QEMU_DIR="$ROOT/.qemu"
QEMU_BIN="$QEMU_DIR/build/qemu-system-xtensa"
QEMU_RV_BIN="$QEMU_DIR/build/qemu-system-riscv32"
# esp-develop commit "hw/riscv: implement ESP32-C6 machine" — the first with an
# esp32c6 machine, and not yet in any tag. Everything between it and the
# previous pin (tag esp-develop-9.2.2-20260417) is RISC-V / C6-only.
QEMU_REF="febae182e132e4055529be423a818225ebddaa3a"
OVERLAY_DIR="$ROOT/qemu"
APPLIED_MARKER="$QEMU_DIR/.pinbench-applied"

# True when a file under qemu/ (the versioned patch set) is newer than the last
# apply.sh run — i.e. the built binary no longer reflects the overlay.
patches_changed() {
  [[ -f "$APPLIED_MARKER" ]] || return 0
  [[ -n "$(find "$OVERLAY_DIR" -type f -newer "$APPLIED_MARKER" -print -quit)" ]]
}

# On macOS the build produces qemu-system-<arch>-unsigned; the codesign step
# may fail in some environments. Fall back to the unsigned binary.
install_unsigned() {
  local bin
  for bin in "$QEMU_BIN" "$QEMU_RV_BIN"; do
    if [[ -f "$bin-unsigned" && ( ! -f "$bin" || "$bin-unsigned" -nt "$bin" ) ]]; then
      cp "$bin-unsigned" "$bin"
      chmod +x "$bin"
    fi
  done
}

# Fast path: re-apply the overlay and rebuild incrementally, skipping the clone
# and ./configure. Used when only the patch set changed.
reapply_and_rebuild() {
  echo "==> qemu/ patch set changed — re-applying and rebuilding incrementally..."
  # apply.sh's machine-file steps are one-shots (they no-op once patched), so
  # restore the pristine files from the clone's git before re-applying; the
  # .c/.h overlay files are copied unconditionally and need no reset.
  git -C "$QEMU_DIR" checkout -- hw/xtensa/esp32s3.c hw/riscv/esp32c6.c 2>/dev/null || true
  bash "$OVERLAY_DIR/apply.sh" "$QEMU_DIR"
  ninja -C "$QEMU_DIR/build" qemu-system-xtensa qemu-system-riscv32
  install_unsigned
  echo "✓ QEMU rebuilt with the current qemu/ patch set: $QEMU_BIN, $QEMU_RV_BIN"
}

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script targets macOS. On Linux, install the dependencies and run"
  echo "this script's apply.sh, configure and ninja steps manually."
  exit 1
fi

# Idempotency: both binaries must exist, support their machine, AND have been
# built with PinBench's additions applied at the pinned commit. If only the
# patch set moved ahead, take the fast re-apply path; otherwise fall through and
# do the full fetch + configure + build.
if [[ -x "$QEMU_BIN" && -x "$QEMU_RV_BIN" && -f "$APPLIED_MARKER" &&
  "$(git -C "$QEMU_DIR" rev-parse HEAD 2>/dev/null)" == "$QEMU_REF" ]]; then
  if "$QEMU_BIN" -machine help 2>/dev/null | grep -q esp32s3 &&
    "$QEMU_RV_BIN" -machine help 2>/dev/null | grep -q esp32c6; then
    if patches_changed; then
      reapply_and_rebuild
      exit 0
    fi
    echo "✓ QEMU esp32s3 + esp32c6 with PinBench additions already built in $QEMU_DIR/build"
    exit 0
  fi
fi

echo "==> Installing build dependencies via Homebrew..."
brew install ninja meson pkg-config glib pixman libgcrypt libgpg-error gnutls nettle libslirp 2>/dev/null || true

echo "==> Fetching espressif/qemu @ $QEMU_REF..."
if [[ ! -d "$QEMU_DIR/hw" ]]; then
  git init -q "$QEMU_DIR"
  git -C "$QEMU_DIR" remote add origin https://github.com/espressif/qemu.git
fi
if [[ "$(git -C "$QEMU_DIR" rev-parse HEAD 2>/dev/null)" != "$QEMU_REF" ]]; then
  # Moving the pin: drop the previous overlay's in-place edits so the checkout
  # is clean; apply.sh re-adds them below.
  git -C "$QEMU_DIR" checkout -q -- . 2>/dev/null || true
  git -C "$QEMU_DIR" fetch -q --depth 1 https://github.com/espressif/qemu.git "$QEMU_REF"
  git -C "$QEMU_DIR" checkout -q --detach "$QEMU_REF"
fi

echo "==> Applying PinBench additions (GP-SPI, GPIO output, device-host bridge)..."
bash "$ROOT/qemu/apply.sh" "$QEMU_DIR"

echo "==> Configuring..."
mkdir -p "$QEMU_DIR/build"
cd "$QEMU_DIR/build"

# Homebrew on Apple Silicon puts libs under /opt/homebrew/opt; make sure
# configure finds gcrypt, slirp, and glib headers.
GCRYPT_PREFIX="$(brew --prefix libgcrypt)"
GPG_ERROR_PREFIX="$(brew --prefix libgpg-error)"
GNUTLS_PREFIX="$(brew --prefix gnutls)"
export PKG_CONFIG_PATH="$GCRYPT_PREFIX/lib/pkgconfig:$GPG_ERROR_PREFIX/lib/pkgconfig:$GNUTLS_PREFIX/lib/pkgconfig:$(brew --prefix libslirp)/lib/pkgconfig:$(brew --prefix glib)/lib/pkgconfig:$(brew --prefix nettle)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export CFLAGS="-I$GCRYPT_PREFIX/include -I$GPG_ERROR_PREFIX/include -I$GNUTLS_PREFIX/include ${CFLAGS:-}"
export LDFLAGS="-L$GCRYPT_PREFIX/lib -L$GPG_ERROR_PREFIX/lib -L$GNUTLS_PREFIX/lib ${LDFLAGS:-}"

../configure --target-list=xtensa-softmmu,riscv32-softmmu \
  --disable-docs --disable-sdl --disable-gtk --disable-vnc \
  --disable-werror --disable-capstone --disable-tools \
  --enable-slirp --enable-gcrypt --enable-debug-info

echo "==> Building (this takes 30-60 minutes on first run)..."
ninja

install_unsigned

echo ""
echo "✓ QEMU built: $QEMU_BIN, $QEMU_RV_BIN"
echo ""
echo "Quick test:"
echo "  $QEMU_BIN -machine help | grep esp32s3"
echo "  $QEMU_RV_BIN -machine help | grep esp32c6"
echo ""
echo "To boot firmware: open PinBench, File ▸ Open… a PlatformIO project, then ▶."
