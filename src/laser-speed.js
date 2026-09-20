/**
 * Speed-code conversion for LHYMICRO-GL, ported from LaserSpeed.py.
 *
 * Provenance: LaserSpeed.py originated as a standalone MIT-licensed module
 * (by Tatarize) and was embedded, unmodified in license terms, in K40
 * Whisperer (`K40_Whisperer-0.71_src/LaserSpeed.py`) — see that file's
 * docstring. This is a direct algorithmic port of that MIT-licensed module.
 *
 * The units are periods: the controller's stepper ticks at a rate derived
 * from a per-board linear equation of a 16-bit "speed value". E.g. on the
 * M2 board, value = 60416 - 12120*T where T is the period in ms. A 1ms
 * period is 1kHz = 25.4mm/s. The speed also selects a "gearing" band
 * (coarse vs fine equation) and, for diagonal moves, a slowed-down value so
 * 45-degree travel takes the same time as the orthogonal equivalent
 * (keeping cut depth consistent).
 */

function getGearForSpeed(mmPerSecond, usesRasterStep = false) {
  if (mmPerSecond <= 25.4) return 1;
  if (mmPerSecond <= 60) return 2;
  if (!usesRasterStep) {
    if (mmPerSecond < 127) return 3;
    return 4;
  }
  if (mmPerSecond < 127) return 2;
  if (mmPerSecond <= 320) return 3;
  return 4;
}

/** @returns {[number, number, number]} [b, m, gear] */
function getGearing(board, mmPerSecond = null, usesRasterStep = false, gear = null) {
  if (gear === null) gear = getGearForSpeed(mmPerSecond, usesRasterStep);

  // A, B, B1, B2
  let bValues = [64752.0, 64752.0, 64640.0, 64512.0];
  let m = -2000.0;
  if (board[0] === 'M') {
    // any M-series board
    bValues = [60416.0, 60416.0, 59904.0, 59392.0];
    m = -12120.0;
  }
  if (board === 'B2') m = -24240.0;

  if (gear === 0) {
    if (board === 'B2') {
      return usesRasterStep ? [bValues[0], m / 12, 1] : [bValues[0], m / 12, 0];
    }
    if (board === 'M' || board === 'M1') return [bValues[0], m, 0];
    if (board === 'M2') return [65528.0, m / 12, 0];
  } else if (mmPerSecond !== null) {
    if (board === 'B2' && mmPerSecond < 7) {
      return usesRasterStep ? [bValues[0], m / 12, 1] : [bValues[0], m / 12, 0];
    }
    if (board === 'M' && mmPerSecond < 6) return [bValues[0], m, 0];
    if (board === 'M1' && (mmPerSecond < 6 || (!usesRasterStep && mmPerSecond < 7))) {
      return [bValues[0], m, 0];
    }
    if (board === 'M2' && mmPerSecond < 7) return [65528.0, m / 12, 0];
  }
  return [bValues[gear - 1], m, gear];
}

function getValueFromPeriod(periodMs, b, m) {
  return m * periodMs + b;
}

function getValueFromSpeed(mmPerSecond, b, m) {
  const frequencyKHz = mmPerSecond / 25.4;
  const periodMs = 1 / frequencyKHz;
  if (!Number.isFinite(periodMs)) return b;
  return getValueFromPeriod(periodMs, b, m);
}

function getPeriodFromValue(value, b, m) {
  if (m === 0) return Infinity;
  return (value - b) / m;
}

function getSpeedFromValue(value, b, m) {
  const periodMs = getPeriodFromValue(value, b, m);
  if (periodMs === 0) return 0;
  const frequencyKHz = 1 / periodMs;
  return 25.4 * frequencyKHz;
}

function encodeValue(value) {
  const v = Math.trunc(value);
  const b0 = v & 255;
  const b1 = (v >> 8) & 0xffffff;
  return `${String(b1).padStart(3, '0')}${String(b0).padStart(3, '0')}`;
}

function decodeValue(code) {
  let b1 = parseInt(code.slice(0, -3), 10);
  if (b1 > 16000000) b1 -= 16777216; // decode error-speed negative numbers
  const b2 = parseInt(code.slice(-3), 10);
  return (b1 << 8) + b2;
}

function parseSpeedCode(speedCodeIn) {
  let speedCode = speedCodeIn;
  let isShortened = false;
  let normal = false;
  if (speedCode[0] === 'C') {
    speedCode = speedCode.slice(1);
    normal = true;
  }
  if (speedCode[speedCode.length - 1] === 'C') {
    speedCode = speedCode.slice(0, -1);
    isShortened = true;
  }

  let codeValue;
  if (speedCode.includes('V1677') || speedCode.includes('V1676')) {
    codeValue = decodeValue(speedCode.slice(1, 12));
    speedCode = speedCode.slice(12);
  } else {
    codeValue = decodeValue(speedCode.slice(1, 7));
    speedCode = speedCode.slice(7);
  }

  let gear = parseInt(speedCode[0], 10);
  speedCode = speedCode.slice(1);
  if (isShortened) gear = 0;
  let rasterStep = 0;

  if (normal) {
    let stepValue = 0;
    let diagonal = 0;
    if (speedCode.length > 1) {
      stepValue = parseInt(speedCode.slice(0, 3), 10);
      diagonal = decodeValue(speedCode.slice(3));
    }
    return { codeValue, gear, stepValue, diagonal, rasterStep };
  }
  if (speedCode.includes('G')) rasterStep = parseInt(speedCode.slice(-3), 10);
  return { codeValue, gear, stepValue: 1, diagonal: 1, rasterStep };
}

export const LaserSpeed = {
  /** Decode a speed code (e.g. "CV1410801") back to mm/s. */
  getSpeedFromCode(speedCode, board = 'M2') {
    const { codeValue, gear, rasterStep } = parseSpeedCode(speedCode);
    const [b, m] = getGearing(board, null, rasterStep !== 0, gear);
    return getSpeedFromValue(codeValue, b, m);
  },

  /**
   * Encode a feed rate as an LHYMICRO-GL speed code.
   *
   * @param {number} mmPerSecondIn
   * @param {number} [rasterStep=0] non-zero selects raster-mode encoding
   *   and appends the `G<step>` suffix.
   * @param {string} [board='M2']
   * @param {number} [dRatio=0.261199033289] diagonal-speed ratio; M1/M2/B1/B2
   *   default. 0 (or board A/B/M) omits the diagonal code entirely.
   * @param {number|null} [gear=null] force a gearing band instead of the
   *   one implied by the speed; 0 selects "C-suffix" notation.
   * @returns {string}
   */
  getCodeFromSpeed(mmPerSecondIn, rasterStep = 0, board = 'M2', dRatio = 0.261199033289, gear = null) {
    let mmPerSecond = mmPerSecondIn;
    if (mmPerSecond > 240 && rasterStep === 0) {
      mmPerSecond = 19.05; // arbitrary default for out-of-range value
    }
    const [b, m, resolvedGear] = getGearing(board, mmPerSecond, rasterStep !== 0, gear);
    gear = resolvedGear;

    let speedValue = getValueFromSpeed(mmPerSecond, b, m);
    if (speedValue - Math.round(speedValue) > 0.005) speedValue = Math.ceil(speedValue);
    speedValue = Math.round(speedValue);
    const encodedSpeed = encodeValue(speedValue);

    if (rasterStep !== 0) {
      const g = gear === 0 ? 1 : gear; // no C-suffix notation for raster
      return `V${encodedSpeed}${g}G${String(rasterStep).padStart(3, '0')}`;
    }

    if (dRatio === 0 || board === 'A' || board === 'B' || board === 'M') {
      return gear === 0 ? `CV${encodedSpeed}1C` : `CV${encodedSpeed}${gear}`;
    }

    const stepValue = Math.min(Math.floor(mmPerSecond) + 1, 128);
    const frequencyKHz = mmPerSecond / 25.4;
    const periodMs = frequencyKHz === 0 ? 0 : 1 / frequencyKHz;
    const dValue = (dRatio * -m * periodMs) / stepValue;
    const encodedDiagonal = encodeValue(dValue);
    if (gear === 0) {
      return `CV${encodedSpeed}1${String(stepValue).padStart(3, '0')}${encodedDiagonal}C`;
    }
    return `CV${encodedSpeed}${gear}${String(stepValue).padStart(3, '0')}${encodedDiagonal}`;
  },
};
