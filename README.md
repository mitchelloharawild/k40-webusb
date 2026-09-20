# k40-webusb

A JavaScript library for controlling a K40 laser cutter's M2-Nano controller
directly from the browser over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) —
no serial port, no native driver, no backend process.

## Features

- Vector cutting, including multi-path jobs with dogleg-optimized travel
  between paths and mid-job feed-rate changes
- Raster (image) engraving, from row-by-row burn intervals
- Runs entirely in the browser via WebUSB

**Requirements:**

- A Chromium-based browser (Chrome, Edge) — WebUSB isn't available in
  Safari or Firefox
- HTTPS or `localhost`, and a user gesture (e.g. a click) to connect
- **Windows:** swap the CH341 driver to WinUSB with [Zadig](https://zadig.akeo.ie/)
  before the device will show up
- **Linux:** a udev rule granting access to the device (VID `1a86`, PID `5512`)
- **macOS:** works out of the box

## Usage

```js
import { K40Transport, buildVectorJob } from 'k40-webusb';

// Must run inside a click/tap handler — connect() needs a user gesture.
const laser = new K40Transport();
await laser.connect();

await laser.unlock();

// Cut a 1" square, 1000 mils per side, at 10mm/s. Points are mils, relative
// to the current head position; each path's first point is a laser-off
// travel move.
//
// A path can override the job's feed rate with { points, feedMmPerSec }
// instead of a plain point array.
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
