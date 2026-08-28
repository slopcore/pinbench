#!/usr/bin/env bash
# Build the espressif/qemu fork with esp32s3 support into .qemu/
# Idempotent: skips if .qemu/build/qemu-system-xtensa already works.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
QEMU_DIR="$ROOT/.qemu"
QEMU_BIN="$QEMU_DIR/build/qemu-system-xtensa"
QEMU_TAG="esp-develop-9.2.2-20260417"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script targets macOS. On Linux, install the dependencies and run"
  echo "the build steps from spike/README.md manually."
  exit 1
fi

# Idempotency: the binary must exist, support esp32s3, AND have been built with
# PinBench's GP-SPI2/3 additions applied — otherwise fall through and rebuild.
if [[ -x "$QEMU_BIN" && -f "$QEMU_DIR/.pinbench-applied" ]]; then
  if "$QEMU_BIN" -machine help 2>/dev/null | grep -q esp32s3; then
    echo "✓ QEMU esp32s3 with PinBench additions already built at $QEMU_BIN"
    exit 0
  fi
fi

echo "==> Installing build dependencies via Homebrew..."
brew install ninja meson pkg-config glib pixman libgcrypt libgpg-error gnutls nettle libslirp 2>/dev/null || true

echo "==> Cloning espressif/qemu ($QEMU_TAG)..."
if [[ -d "$QEMU_DIR/hw" ]]; then
  echo "    Source already present, skipping clone"
else
  git clone --depth 1 --branch "$QEMU_TAG" \
    https://github.com/espressif/qemu.git "$QEMU_DIR"
fi

echo "==> Applying PinBench ESP32-S3 additions (GP-SPI2/3, GPIO output, device-host bridge)..."
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

../configure --target-list=xtensa-softmmu \
  --disable-docs --disable-sdl --disable-gtk --disable-vnc \
  --disable-werror --disable-capstone --disable-tools \
  --enable-slirp --enable-gcrypt --enable-debug-info

echo "==> Building (this takes 30-60 minutes on first run)..."
ninja

# On macOS the build produces qemu-system-xtensa-unsigned; the codesign step
# may fail in some environments. Fall back to the unsigned binary.
if [[ ! -f "$QEMU_BIN" && -f "$QEMU_DIR/build/qemu-system-xtensa-unsigned" ]]; then
  cp "$QEMU_DIR/build/qemu-system-xtensa-unsigned" "$QEMU_BIN"
  chmod +x "$QEMU_BIN"
fi

echo ""
echo "✓ QEMU built: $QEMU_BIN"
echo ""
echo "Quick test:"
echo "  $QEMU_BIN -machine help | grep esp32s3"
echo ""
echo "To build and boot the spike firmware:"
echo "  pio run -d spike/firmware/bench"
echo "  spike/bin/mkflash.sh spike/firmware/bench/.pio/build/esp32s3 .qemu/bench-flash.bin"
echo "  Open PinBench → File ▸ Open firmware image → .qemu/bench-flash.bin → Start"
