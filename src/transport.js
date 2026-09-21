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
 * string). Unused payload bytes are padded with `padByte` (default 'F',
 * matching the job-stream framing in `send_data()`) and the trailing CRC
 * byte is computed over bytes[1..31] inclusive, matching
 * `OneWireCRC(packet[1:len(packet)-2])` in nano_library.py.
 *
 * The AT-prefixed power-control packets (see `buildSetPowerPacket()` et al.
 * below) are the one exception in the upstream protocol: nano_library.py's
 * literal arrays for those pad with 0x00, not 'F' — pass `padByte: 0x00` to
 * match.
 *
 * @param {string | Iterable<number>} payload
 * @param {{ padByte?: number }} [options]
 * @returns {Uint8Array} 34-byte packet
 */
export function buildPacket(payload, { padByte = PAD_BYTE } = {}) {
  const bytes = typeof payload === 'string' ? textBytes(payload) : Array.from(payload);
  if (bytes.length > PAYLOAD_LENGTH) {
    throw new RangeError(`payload too long for one packet (${bytes.length} > ${PAYLOAD_LENGTH})`);
  }
  const packet = new Uint8Array(PACKET_LENGTH);
  packet[0] = FRAME_HEADER;
  packet[1] = 0x00;
  for (let i = 0; i < PAYLOAD_LENGTH; i++) {
    packet[2 + i] = i < bytes.length ? bytes[i] : padByte;
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

/**
 * Encode a 0-100% power level as the M3-Nano's two-byte `m`/`n` PWM value,
 * matching `set_PWM_register()`/`pulse_laser()` in nano_library.py.
 * @param {number} pctPower 0-100
 * @returns {[number, number]} [m, n]
 */
function encodePower(pctPower) {
  if (!(pctPower >= 0 && pctPower <= 100)) {
    throw new RangeError(`pctPower must be within 0-100 (got ${pctPower})`);
  }
  const power = Math.round(pctPower * 10);
  return [Math.floor(power / 254), power % 254];
}

/**
 * Build an "AT1" set-PWM-register packet: sets the laser's power level for
 * whatever fires next (a job or a test pulse) without firing it itself.
 * **M3-Nano only** — the stock M2-Nano has no PWM register; power there is
 * set purely by the physical potentiometer. Ported from `set_PWM_register()`
 * in nano_library.py:451-458. Zero-padded (see `buildPacket()`'s note),
 * unlike ordinary job-stream packets.
 * @param {number} pctPower 0-100
 * @returns {Uint8Array} 34-byte packet
 */
export function buildSetPowerPacket(pctPower) {
  const [m, n] = encodePower(pctPower);
  return buildPacket([65, 84, 49, m, n], { padByte: 0x00 });
}

/**
 * Build an "AT0" pulse (test-fire) packet for a single chunk of up to 254ms.
 * **M3-Nano only.** Ported from `pulse_laser()` in nano_library.py:430-448 —
 * that function itself chunks a longer duration into repeated ≤254ms
 * packets; `K40Transport#pulse()` does that chunking and calls this once per
 * chunk. Zero-padded, unlike ordinary job-stream packets.
 * @param {number} pctPower 0-100
 * @param {number} durationMs 0-254
 * @returns {Uint8Array} 34-byte packet
 */
export function buildPulsePacket(pctPower, durationMs) {
  if (!(durationMs >= 0 && durationMs <= 254)) {
    throw new RangeError(`durationMs must be within 0-254 for a single pulse chunk (got ${durationMs})`);
  }
  const [m, n] = encodePower(pctPower);
  return buildPacket([65, 84, 48, m, n, durationMs], { padByte: 0x00 });
}

/**
 * "AT00" fixed packet that stops an in-progress test pulse. **M3-Nano
 * only.** Ported from `disable_shot_laser()` in nano_library.py:460-463.
 */
export const DISABLE_TEST_FIRE_PACKET = buildPacket([65, 84, 48, 48], { padByte: 0x00 });

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

  /**
   * Poll until the controller reports the running job is finished.
   * @param {AbortSignal} [signal] checked before each poll; an already-aborted
   *   or newly-aborted signal rejects with an `AbortError` `DOMException`
   *   instead of continuing to wait.
   */
  async waitForFinish(signal) {
    for (;;) {
      if (signal?.aborted) throw new DOMException('K40Transport: aborted while waiting for finish', 'AbortError');
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
   *
   * `signal`, if given, is checked before each packet write; once aborted, no
   * further packets are sent and the returned promise rejects with an
   * `AbortError` `DOMException` instead of waiting for completion. The
   * controller itself has no cancel command — this only stops feeding it more
   * of the stream, so whatever's already buffered on the board keeps running
   * until it drains. Follow an abort with `estop()` if the motion itself also
   * needs to be stopped.
   *
   * @param {Iterable<number>} bytes
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(sentBytes: number, totalBytes: number) => void} [options.onProgress]
   * @returns {Promise<number>} the completion Status (`TASK_COMPLETE` or
   *   `TASK_COMPLETE_M3`) `waitForFinish()` saw
   */
  async sendJob(bytes, { signal, onProgress } = {}) {
    const data = Array.from(bytes);
    for (let offset = 0; offset < data.length; offset += PAYLOAD_LENGTH) {
      if (signal?.aborted) throw new DOMException('K40Transport: job aborted', 'AbortError');
      const chunk = data.slice(offset, offset + PAYLOAD_LENGTH);
      await this.sendPacket(buildPacket(chunk));
      onProgress?.(Math.min(offset + PAYLOAD_LENGTH, data.length), data.length);
    }
    if (signal?.aborted) throw new DOMException('K40Transport: job aborted', 'AbortError');
    return this.waitForFinish(signal);
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

  /**
   * Set the M3-Nano's PWM power register (0-100%) for whatever fires next —
   * a job or `pulse()`. **M3-Nano only**: the stock M2-Nano ignores this
   * (no PWM register wired up); power there is set by the physical
   * potentiometer.
   * @param {number} pctPower 0-100
   */
  async setPower(pctPower) {
    return this.sendPacket(buildSetPowerPacket(pctPower));
  }

  /**
   * Fire the laser at `pctPower` for `ms` milliseconds — used for test-fire
   * power calibration, not job cutting. **M3-Nano only.** Chunks `ms` into
   * ≤254ms packets, matching `pulse_laser()` in nano_library.py:430-448:
   * `Math.floor(ms / 254)` full 254ms chunks, then always one final chunk of
   * `ms % 254` (even when that's 0).
   * @param {number} pctPower 0-100
   * @param {number} ms >= 0
   */
  async pulse(pctPower, ms) {
    const wholeChunks = Math.floor(ms / 254);
    for (let i = 0; i < wholeChunks; i++) {
      await this.sendPacket(buildPulsePacket(pctPower, 254));
    }
    await this.sendPacket(buildPulsePacket(pctPower, ms % 254));
  }

  /**
   * Stop an in-progress `pulse()` test-fire early. **M3-Nano only.**
   */
  async stopTestFire() {
    return this.sendPacket(DISABLE_TEST_FIRE_PACKET);
  }
}
