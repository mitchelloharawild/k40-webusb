import { oneWireCrc } from './crc.js';

/** M2-Nano's CH341 in vendor bulk-transfer mode — not CDC-ACM serial. */
export const VENDOR_ID = 0x1a86;
export const PRODUCT_ID = 0x5512;

const FRAME_HEADER = 0xa6;
const PACKET_LENGTH = 34;
const PAYLOAD_LENGTH = 30;
const PAD_BYTE = 0x46; // 'F'
const READ_LENGTH = 168;

/** Status byte values returned in response[1] to a "hello" poll. */
export const Status = Object.freeze({
  OK: 206,
  BUFFER_FULL: 238,
  CRC_ERROR: 207,
  TASK_COMPLETE: 236,
  TASK_COMPLETE_M3: 204,
  UNKNOWN_2: 239,
});

function textBytes(str) {
  return Array.from(str, (c) => c.charCodeAt(0));
}

/**
 * Build a framed 34-byte packet from up to 30 payload bytes (or an ASCII
 * string). Unused payload bytes are padded with 'F' and the trailing CRC
 * byte is computed over bytes[1..31] inclusive, matching `send_data()` /
 * `OneWireCRC(packet[1:len(packet)-2])` in nano_library.py.
 *
 * @param {string | Iterable<number>} payload
 * @returns {Uint8Array} 34-byte packet
 */
export function buildPacket(payload) {
  const bytes = typeof payload === 'string' ? textBytes(payload) : Array.from(payload);
  if (bytes.length > PAYLOAD_LENGTH) {
    throw new RangeError(`payload too long for one packet (${bytes.length} > ${PAYLOAD_LENGTH})`);
  }
  const packet = new Uint8Array(PACKET_LENGTH);
  packet[0] = FRAME_HEADER;
  packet[1] = 0x00;
  for (let i = 0; i < PAYLOAD_LENGTH; i++) {
    packet[2 + i] = i < bytes.length ? bytes[i] : PAD_BYTE;
  }
  packet[32] = FRAME_HEADER;
  packet[33] = oneWireCrc(packet.subarray(1, 32));
  return packet;
}

/** Unframed 1-byte status poll — sent as-is, not wrapped by buildPacket(). */
export const HELLO_PACKET = new Uint8Array([0xa0]);

export const UNLOCK_PACKET = buildPacket('IS2P');
export const HOME_PACKET = buildPacket('IPP');
export const ESTOP_PACKET = buildPacket('I');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WebUSB transport for the K40's M2-Nano controller. Owns the device
 * session, packet framing/CRC, and the status-poll handshake that guards
 * every packet write. Knows nothing about the LHYMICRO-GL command language —
 * see lhymicro.js for that layer.
 */
export class K40Transport {
  #device = null;
  #outEndpoint = null;
  #inEndpoint = null;

  constructor({ timeoutMs = 200, maxRetries = 10 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  get connected() {
    return this.#device !== null;
  }

  /**
   * Prompt the user to pick the device (must be called from a user gesture,
   * e.g. a button click) and open a session with it.
   */
  async connect() {
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
    });
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // Discover the bulk IN/OUT endpoints rather than assuming interface 0 /
    // endpoints 0x2 and 0x82, mirroring nano_library.py's endpoint scan
    // instead of hardcoding numbers that may shift between boards/firmware.
    const iface = device.configuration.interfaces.find((i) =>
      i.alternates.some((alt) => alt.endpoints.some((e) => e.type === 'bulk')),
    );
    if (!iface) throw new Error('K40Transport: no bulk-transfer interface found on device');
    await device.claimInterface(iface.interfaceNumber);
    const alt = iface.alternates.find((a) => a.endpoints.some((e) => e.type === 'bulk'));
    const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    if (!outEp || !inEp) {
      throw new Error('K40Transport: expected both a bulk IN and a bulk OUT endpoint');
    }

    // One-time vendor control transfer required by the controller before
    // it will respond to bulk transfers (nano_library.py:423). Purpose is
    // undocumented upstream but reproduced here as observed.
    await device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: 177,
      value: 0x0102,
      index: 0,
    });

    this.#device = device;
    this.#outEndpoint = outEp.endpointNumber;
    this.#inEndpoint = inEp.endpointNumber;
    return device;
  }

  async disconnect() {
    if (!this.#device) return;
    await this.#device.close();
    this.#device = null;
    this.#outEndpoint = null;
    this.#inEndpoint = null;
  }

  async #writeRaw(bytes) {
    const result = await this.#device.transferOut(this.#outEndpoint, bytes);
    if (result.status !== 'ok') {
      throw new Error(`K40Transport: USB write failed (${result.status})`);
    }
  }

  async #readStatus() {
    const result = await this.#device.transferIn(this.#inEndpoint, READ_LENGTH);
    if (result.status !== 'ok' || !result.data || result.data.byteLength < 2) {
      return null;
    }
    return result.data.getUint8(1);
  }

  /**
   * Poll the controller's status. Retries silently on a missing/short
   * response (a genuinely unresponsive device) up to maxRetries times.
   * @returns {Promise<number|null>} a Status value, or null if unresponsive
   */
  async hello() {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.#writeRaw(HELLO_PACKET);
      const status = await this.#readStatus();
      if (status !== null) return status;
      await sleep(this.timeoutMs);
    }
    return null;
  }

  /**
   * Send one already-framed 34-byte packet, honoring the buffer-full /
   * CRC-error handshake (send_packet_w_error_checking in nano_library.py).
   * There is no other flow-control signal from the controller — buffer-full
   * must be polled until it clears.
   */
  async sendPacket(packet) {
    let status = await this.hello();
    while (status === Status.BUFFER_FULL) {
      await sleep(this.timeoutMs);
      status = await this.hello();
    }

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.#writeRaw(packet);
      status = await this.hello();
      if (status !== Status.CRC_ERROR) return status;
      // CRC error: resend the identical packet.
    }
    throw new Error('K40Transport: CRC error persisted after max retries');
  }

  /** Poll until the controller reports the running job is finished. */
  async waitForFinish() {
    for (;;) {
      const status = await this.hello();
      if (status === Status.TASK_COMPLETE || status === Status.TASK_COMPLETE_M3) {
        return status;
      }
      await sleep(this.timeoutMs);
    }
  }

  /**
   * Send a full LHYMICRO-GL byte stream (from lhymicro.js), chunked into
   * 30-byte payloads and framed/verified packet-by-packet, then block until
   * the controller reports completion.
   * @param {Iterable<number>} bytes
   */
  async sendJob(bytes) {
    const data = Array.from(bytes);
    for (let offset = 0; offset < data.length; offset += PAYLOAD_LENGTH) {
      const chunk = data.slice(offset, offset + PAYLOAD_LENGTH);
      await this.sendPacket(buildPacket(chunk));
    }
    await this.waitForFinish();
  }

  async unlock() {
    return this.sendPacket(UNLOCK_PACKET);
  }

  async home() {
    return this.sendPacket(HOME_PACKET);
  }

  async estop() {
    return this.sendPacket(ESTOP_PACKET);
  }
}
