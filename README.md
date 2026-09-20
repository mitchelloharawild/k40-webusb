# k40-webusb

A JavaScript library for controlling a K40 laser cutter's M2-Nano controller
directly from the browser over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) —
no serial port, no native driver, no backend process. It re-implements the
protocol reverse-engineered by [K40 Whisperer](https://www.scorchworks.com/K40whisperer/k40whisperer.html)
(see `NOTICE.md` for provenance).

This is an early scaffold: the low-level transport and the straight/diagonal
vector-cutting path are implemented, including dogleg-optimized rapid travel
between cut paths; raster jobs and mid-job speed changes are not yet ported.

## Why WebUSB, not Web Serial

The M2-Nano's controller is a CH341 chip (VID `0x1a86`, PID `0x5512`) run in
a vendor-specific bulk-transfer mode, not CDC-ACM serial — it never appears
as a COM port or `/dev/ttyUSB*` device, so the Web Serial API cannot see it.
WebUSB is the only browser API with the right level of access.

**Platform notes:**

- **Windows** requires swapping the CH341 driver to WinUSB with
  [Zadig](https://zadig.akeo.ie/) before `requestDevice()` will list the
  device — this is the biggest real-world adoption blocker.
- **Linux** needs a udev rule granting user access to `1a86:5512`.
- **macOS** generally works out of the box.
- Only Chromium-based browsers (Chrome, Edge) implement WebUSB — no Safari
  or Firefox support, on any OS.
- WebUSB requires a secure context (HTTPS or `localhost`) and a user gesture
  to call `requestDevice()`.

## Usage

```js
import { K40Transport, buildVectorJob } from 'k40-webusb';

// Must run inside a click/tap handler — requestDevice() needs a user gesture.
const laser = new K40Transport();
await laser.connect();

await laser.unlock();

// Cut a 1" square, 1000 mils per side, at 10mm/s. Points are mils, relative
// to the current head position; each path's first point is a laser-off
// travel move. Travel between paths (and back to the start at the end) is
// a plain move when short, or a dogleg-shaped "rapid" move when long enough
// that dragging the head straight through material would matter.
const job = buildVectorJob({
  paths: [
    [
      [0, 1000],
      [1000, 1000],
      [1000, 0],
      [0, 0],
    ],
  ],
  feedMmPerSec: 10,
});
await laser.sendJob(job);

await laser.disconnect();
```

## Module layout

- `src/crc.js` — 1-Wire/Dallas CRC-8 used to checksum every packet.
- `src/transport.js` — WebUSB session management, 34-byte packet framing,
  the status-poll handshake, `K40Transport`.
- `src/laser-speed.js` — feed-rate ↔ speed-code conversion (`LaserSpeed`).
- `src/lhymicro.js` — the LHYMICRO-GL opcode language: modal move tracking,
  distance encoding, diagonal cut-line decomposition, `buildVectorJob()`.
- `src/index.js` — public API barrel.

## Known gaps

- Only PID `0x5512` (genuine M2-Nano boards) is targeted; other
  Lihuiyu/Moshiboard variants use different PIDs and aren't covered.
- No raster (image engraving) job support yet.
- No mid-job speed changes — every path in a job is cut at a single feed
  rate.
- Timing constants (200ms status-poll timeout, 10 retries) are carried over
  from K40 Whisperer's empirically-tuned values; expect to re-tune against
  real hardware.
