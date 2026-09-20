/**
 * 1-Wire / Dallas CRC-8 (polynomial 0x8C, LSB-first).
 *
 * The M2-Nano controller checksums every 34-byte packet with this algorithm.
 * Ported byte-for-byte from `OneWireCRC()` in K40 Whisperer's
 * nano_library.py — bit order matters, do not "simplify" this.
 *
 * @param {Iterable<number>} bytes
 * @returns {number} CRC-8 value (0-255)
 */
export function oneWireCrc(bytes) {
  let crc = 0;
  for (let byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      const mix = (crc ^ byte) & 0x01;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      byte >>= 1;
    }
  }
  return crc;
}
