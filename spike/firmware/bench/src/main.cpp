/*
 * PinBench M0 spike - drives the pinbench-bench harness in QEMU and prints
 * results as CSV on UART0.
 *
 * Real firmware, real MMIO, real vCPU blocking: the numbers include every
 * cost a device model imposes on the guest.
 */
#include <Arduino.h>

static const uint32_t BENCH_BASE = 0x60041000;

#define REG(off) (*(volatile uint32_t *)(BENCH_BASE + (off)))
#define R_MODE     0x00
#define R_LEN      0x04
#define R_ITERS    0x08
#define R_GO       0x0c
#define R_NS_LO    0x10
#define R_NS_HI    0x14
#define R_CHECKSUM 0x18
#define R_STATUS   0x1c
#define R_MAGIC    0x20

static const char *MODE_NAME[] = {
  "native-direct", "bridge-byte", "bridge-burst",
  "native-burst",  "ssi-native",  "ssi-bridge",
};
static const int N_MODES = 6;

// 320x240x16bpp: one ST7789 full-frame flush.
static const uint32_t FRAME_BYTES = 320UL * 240UL * 2UL;

static void run(int mode, uint32_t len, uint32_t iters) {
  REG(R_MODE)  = mode;
  REG(R_LEN)   = len;
  REG(R_ITERS) = iters;
  REG(R_GO)    = 1;

  uint64_t ns = ((uint64_t)REG(R_NS_HI) << 32) | REG(R_NS_LO);
  uint32_t status = REG(R_STATUS);
  uint32_t sum = REG(R_CHECKSUM);

  uint64_t total = (uint64_t)len * iters;
  double per_byte_ns = total ? (double)ns / (double)total : 0.0;
  double mb_per_s = ns ? ((double)total / 1048576.0) / ((double)ns / 1e9) : 0.0;
  double per_frame_ms = per_byte_ns * (double)FRAME_BYTES / 1e6;

  Serial.printf("RESULT,%s,%lu,%lu,%llu,%.1f,%.2f,%.2f,0x%08lx,%lu\n",
                MODE_NAME[mode], (unsigned long)len, (unsigned long)iters,
                (unsigned long long)ns, per_byte_ns, mb_per_s, per_frame_ms,
                (unsigned long)sum, (unsigned long)status);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  uint32_t magic = REG(R_MAGIC);
  Serial.printf("\nPinBench M0 harness magic=0x%08lx (want 0x50424e31)\n",
                (unsigned long)magic);
  if (magic != 0x50424e31UL) {
    Serial.println("harness not present - start qemu with PINBENCH_BRIDGE_SOCKET set");
    return;
  }

  Serial.println("HEADER,mode,len,iters,elapsed_ns,ns_per_byte,MiB_per_s,ms_per_frame,checksum,status");

  // 1. Single-byte round trip. 2000 iterations of one byte.
  for (int m = 0; m < N_MODES; m++) run(m, 1, 2000);

  // 2. One full framebuffer flush, five times.
  for (int m = 0; m < N_MODES; m++) run(m, FRAME_BYTES, 5);

  // 3. Sweep burst size, bridged only: where does batching start to pay?
  for (uint32_t len = 16; len <= 65536; len *= 4) {
    uint32_t iters = 65536UL / len;   // same total bytes at every point
    run(1, len, iters);  // bridge-byte
    run(2, len, iters);  // bridge-burst
  }

  Serial.println("DONE");
}

void loop() { delay(1000); }
