#!/usr/bin/env bash
# PinBench M0 spike - run the measurement firmware under QEMU with the Node
# device host attached, and dump the CSV it prints on UART0.
#
#   usage: run-bench.sh <qemu-build-dir> <flash.bin> [out.csv]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
QEMU_BUILD="${1:?usage: run-bench.sh <qemu-build-dir> <flash.bin> [out.csv]}"
FLASH="${2:?missing flash image}"
OUT="${3:-$HERE/results/bench.csv}"
SOCK="${PINBENCH_BRIDGE_SOCKET:-/tmp/pinbench-bridge.sock}"

mkdir -p "$(dirname "$OUT")"
rm -f "$SOCK"

node "$HERE/bridge-server/server.mjs" "$SOCK" &
HOST=$!
trap 'kill $HOST 2>/dev/null || true; rm -f "$SOCK"' EXIT

for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "device host never came up" >&2; exit 1; }

SERIAL="$(mktemp)"
PINBENCH_BRIDGE_SOCKET="$SOCK" timeout 600 \
  "$QEMU_BUILD/qemu-system-xtensa" -nographic -machine esp32s3 \
  -drive file="$FLASH",if=mtd,format=raw \
  -serial "file:$SERIAL" >/dev/null 2>&1 &
QEMU=$!

# The firmware prints DONE when the last mode has run.
for _ in $(seq 1 600); do
  grep -q '^DONE' "$SERIAL" 2>/dev/null && break
  kill -0 $QEMU 2>/dev/null || break
  sleep 1
done
kill $QEMU 2>/dev/null || true
wait $QEMU 2>/dev/null || true

grep -E '^(HEADER|RESULT),' "$SERIAL" | sed 's/^HEADER,//; s/^RESULT,//' > "$OUT"
echo "--- $OUT"
sed "s/,/\t/g" < "$OUT"
grep -q '^DONE' "$SERIAL" || echo "WARNING: firmware did not reach DONE" >&2
