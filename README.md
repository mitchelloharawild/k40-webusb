# k40-webusb

A JavaScript library for controlling a K40 laser cutter's M2-Nano controller
directly from the browser over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) —
no serial port, no native driver, no backend process. It re-implements the
protocol reverse-engineered by [K40 Whisperer](https://www.scorchworks.com/K40whisperer/k40whisperer.html)
(see `NOTICE.md` for provenance).

This is an early scaffold: the low-level transport and the straight/diagonal
vector-cutting and raster (image engraving) paths are implemented,
including dogleg-optimized rapid travel between vector cut paths; mid-job
speed changes and the raster path's rapid-travel mode are not yet ported.

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

Raster (image engraving) jobs scan bidirectionally, row by row; each row is
a list of `[xStart, xEnd]` laser-on intervals (mils) rather than a full
bitmap, so you decide how to derive burn intervals from your image (e.g.
thresholding pixels and run-length-encoding each row):

```js
import { K40Transport, buildRasterJob } from 'k40-webusb';

const laser = new K40Transport();
await laser.connect();
await laser.unlock();

const job = buildRasterJob({
  rows: [
    [[0, 1000]], // row 0: burn from 0 to 1000 mils
    [[200, 800]], // row 1
    [[0, 1000]], // row 2
  ],
  rowStepMils: 10, // 10 mils between rows
  feedMmPerSec: 100,
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
  distance encoding, diagonal cut-line decomposition, `buildVectorJob()`,
  `buildRasterJob()`.
- `src/index.js` — public API barrel.

## Known gaps

- Raster jobs require every row to have at least one burn interval — the
  original's blank-row jump-ahead optimization (collapsing several blank
  rows into one larger Y move) isn't ported.
- No mid-job speed changes — every path in a vector job, and the whole
  raster job, is cut at a single feed rate.
- Raster jobs don't yet get the dogleg/rapid-feed travel optimizations that
  vector jobs' between-path travel has.
