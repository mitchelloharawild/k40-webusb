/**
 * LHYMICRO-GL: the byte-opcode job language the M2-Nano executes.
 *
 * Ported from egv.py's `egv` class (move/flush/make_distance/make_dir_dist/
 * make_cut_line/make_egv_data). This covers straight-line vector cutting;
 * it does NOT yet port raster jobs, mid-job speed changes (change_speed),
 * or the "rapid_move_fast" dogleg optimization for non-cutting travel —
 * see _dev/webapp.md §6 in k40-control for what those do in the original.
 */
import { LaserSpeed } from './laser-speed.js';

export const Opcode = Object.freeze({
  RIGHT: 66, // 'B'
  LEFT: 84, // 'T'
  UP: 76, // 'L'
  DOWN: 82, // 'R'
  ANGLE: 77, // 'M' — diagonal move; preceded by an X-axis and Y-axis code
  LASER_ON: 68, // 'D'
  LASER_OFF: 85, // 'U'
});

/**
 * Encode a distance in mils (1/1000 inch) as LHYMICRO-GL distance bytes.
 * Ported from `make_distance()` in egv.py.
 *
 * - 0: nothing
 * - 1-25: single byte 'a'+(n-1)
 * - 26-51: two bytes '|' then 'a'+(n-26)
 * - 52-254: three ASCII digit bytes, zero-padded
 * - each whole multiple of 255: a literal byte 'z' (122), remainder per above
 *
 * @param {number} distMils non-negative integer
 * @returns {number[]} char codes
 */
export function encodeDistance(distMils) {
  if (Math.abs(distMils - Math.round(distMils)) > 1e-6) {
    throw new Error('encodeDistance: distance must be an integer (inches * 1000)');
  }
  const codes = [];
  const v122 = 255;
  let remaining = Math.round(distMils);

  while (remaining >= v122) {
    codes.push(122); // 'z'
    remaining -= v122;
  }

  if (remaining === 0) {
    // nothing
  } else if (remaining < 26) {
    codes.push(96 + remaining);
  } else if (remaining < 52) {
    codes.push(124); // '|'
    codes.push(96 + remaining - 25);
  } else if (remaining < 255) {
    const s = String(remaining).padStart(3, '0');
    codes.push(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2));
  } else {
    throw new Error(`encodeDistance: unreachable remainder ${remaining}`);
  }
  return codes;
}

/**
 * Modal LHYMICRO-GL opcode emitter: tracks the current direction/laser
 * state so repeated moves in the same direction just extend the pending
 * distance, matching `move()`/`flush()` in egv.py. Bytes are pushed onto
 * an internal buffer, retrievable via `toBytes()`.
 */
export class LhymicroEncoder {
  #codes = [];
  #modalDir = 0;
  #modalDist = 0;
  #modalOn = false;
  #modalAX = 0;
  #modalAY = 0;

  #write(byte) {
    this.#codes.push(byte);
  }

  /**
   * @param {number} direction one of Opcode.RIGHT/LEFT/UP/DOWN/ANGLE
   * @param {number} distance mils, >= 0
   * @param {boolean} [laserOn=false]
   * @param {[number, number]|null} [angleDirs=null] required axis signs when
   *   direction is Opcode.ANGLE; defaults to the current modal axis state.
   */
  move(direction, distance, laserOn = false, angleDirs = null) {
    const [ax, ay] = angleDirs ?? [this.#modalAX, this.#modalAY];

    if (
      direction === this.#modalDir &&
      laserOn === this.#modalOn &&
      ax === this.#modalAX &&
      ay === this.#modalAY
    ) {
      this.#modalDist += distance;
      return;
    }

    this.flush();
    if (laserOn !== this.#modalOn) {
      this.#write(laserOn ? Opcode.LASER_ON : Opcode.LASER_OFF);
      this.#modalOn = laserOn;
    }

    if (direction === Opcode.ANGLE) {
      if (ax !== this.#modalAX) {
        this.#write(ax);
        this.#modalAX = ax;
      }
      if (ay !== this.#modalAY) {
        this.#write(ay);
        this.#modalAY = ay;
      }
    }

    this.#modalDir = direction;
    this.#modalDist = distance;

    if (direction === Opcode.RIGHT || direction === Opcode.LEFT) this.#modalAX = direction;
    if (direction === Opcode.UP || direction === Opcode.DOWN) this.#modalAY = direction;
  }

  /** Flush any pending modal distance, optionally also forcing laser state. */
  flush(laserOn = null) {
    if (this.#modalDist > 0) {
      this.#write(this.#modalDir);
      for (const code of encodeDistance(this.#modalDist)) this.#write(code);
    }
    if (laserOn !== null && laserOn !== this.#modalOn) {
      this.#write(laserOn ? Opcode.LASER_ON : Opcode.LASER_OFF);
      this.#modalOn = laserOn;
    }
    this.#modalDist = 0;
  }

  /** Emit an axis-aligned (non-diagonal) move; ported from `make_dir_dist()`. */
  makeDirDist(dxMils, dyMils, laserOn = false) {
    const adx = Math.abs(dxMils);
    const ady = Math.abs(dyMils);
    if (adx > 0 || ady > 0) {
      if (ady > 0) this.move(dyMils > 0 ? Opcode.UP : Opcode.DOWN, ady, laserOn);
      if (adx > 0) this.move(dxMils > 0 ? Opcode.RIGHT : Opcode.LEFT, adx, laserOn);
    }
  }

  /**
   * Emit a single cut segment of arbitrary slope, ported from
   * `make_cut_line()`. Axis-aligned and pure-45-degree segments are a
   * single move; anything else is Bresenham-decomposed into a run of
   * single-axis steps interleaved with 45-degree (ANGLE) steps, since the
   * controller only steps at 0/45/90 degrees.
   *
   * @param {number} dxMils integer mils
   * @param {number} dyMils integer mils
   * @param {boolean} laserOn
   */
  makeCutLine(dxMils, dyMils, laserOn) {
    const xCode = dxMils < 0 ? Opcode.LEFT : Opcode.RIGHT;
    const yCode = dyMils < 0 ? Opcode.DOWN : Opcode.UP;

    if (Math.abs(dxMils - Math.round(dxMils)) > 0 || Math.abs(dyMils - Math.round(dyMils)) > 0) {
      throw new Error('makeCutLine: distance values must be integer (inches * 1000)');
    }

    if (dxMils === 0) {
      this.move(yCode, Math.abs(dyMils), laserOn);
      return;
    }
    if (dyMils === 0) {
      this.move(xCode, Math.abs(dxMils), laserOn);
      return;
    }
    if (dxMils === dyMils) {
      this.move(Opcode.ANGLE, Math.abs(dxMils), laserOn, [xCode, yCode]);
      return;
    }

    const adx = Math.abs(dxMils);
    const ady = Math.abs(dyMils);
    let n, code, slope;
    if (adx > ady) {
      slope = ady / adx;
      n = Math.trunc(adx);
      code = xCode;
    } else {
      slope = adx / ady;
      n = Math.trunc(ady);
      code = yCode;
    }

    const h = [];
    for (let i = 1; i <= n; i++) h.push(Math.round(i * slope));

    let last = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i] === last) {
        d1 += 1;
        if (d2 > 0) {
          this.move(Opcode.ANGLE, d2, laserOn, [xCode, yCode]);
          d2 = 0;
        }
      } else {
        d2 += 1;
        if (d1 > 0) {
          this.move(code, d1, laserOn);
          d1 = 0;
        }
      }
      last = h[i];
    }
    if (d1 > 0) this.move(code, d1, laserOn);
    if (d2 > 0) this.move(Opcode.ANGLE, d2, laserOn, [xCode, yCode]);
  }

  toBytes() {
    return Uint8Array.from(this.#codes);
  }
}

/**
 * Encode a feed rate as LHYMICRO-GL speed-code bytes (char codes), ready to
 * prepend to a job. Thin wrapper over LaserSpeed matching `make_speed()`.
 * @param {number} feedMmPerSec
 * @param {string} [board='M2']
 * @param {number} [rasterStep=0]
 * @returns {number[]}
 */
export function makeSpeed(feedMmPerSec, board = 'M2', rasterStep = 0) {
  const text = LaserSpeed.getCodeFromSpeed(feedMmPerSec, Math.abs(rasterStep), board);
  return Array.from(text, (c) => c.charCodeAt(0));
}

function ascii(str) {
  return Array.from(str, (c) => c.charCodeAt(0));
}

/**
 * Build a complete vector-cut job: speed code, header, a straight/diagonal
 * cut through each point in order, and a return move + footer — the
 * `Raster_step == 0` branch of `make_egv_data()` in egv.py, minus rapid-move
 * dogleg optimization and mid-job speed changes.
 *
 * @param {object} opts
 * @param {[number, number][]} opts.points path vertices in mils, relative
 *   to the machine's current position; points[0] is a laser-off travel move,
 *   subsequent points are cut with the laser on.
 * @param {number} opts.feedMmPerSec
 * @param {string} [opts.board='M2']
 * @returns {Uint8Array} bytes ready for `K40Transport#sendJob()`
 */
export function buildVectorJob({ points, feedMmPerSec, board = 'M2' }) {
  if (points.length < 2) {
    throw new Error('buildVectorJob: need at least a start point and one cut point');
  }

  const bytes = [];
  const push = (arr) => bytes.push(...arr);

  push(makeSpeed(feedMmPerSec, board, 0));

  // Initial travel move (laser off) from the current head position to the
  // first path vertex. `points` are mils, relative to that starting position.
  const [startX, startY] = points[0];
  const headerEnc = new LhymicroEncoder();
  headerEnc.makeDirDist(startX, startY, false);
  headerEnc.flush(false);
  push(headerEnc.toBytes());

  push(ascii('N'));
  push([startY <= 0 ? Opcode.DOWN : Opcode.UP]);
  push([startX >= 0 ? Opcode.RIGHT : Opcode.LEFT]);
  push(ascii('S1E'));

  // Cut through the remaining vertices in order, laser on throughout.
  const cutEnc = new LhymicroEncoder();
  let lastX = startX;
  let lastY = startY;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    cutEnc.makeCutLine(x - lastX, y - lastY, true);
    lastX = x;
    lastY = y;
  }
  cutEnc.flush(false);
  push(cutEnc.toBytes());

  // Plain (non-optimized) travel move back to the job's starting position.
  // egv.py instead picks between a "dogleg" rapid move and a temporary
  // rapid feed rate here (rapid_move_fast/rapid_move_slow) — not ported.
  const returnEnc = new LhymicroEncoder();
  returnEnc.makeDirDist(-lastX, -lastY, false);
  returnEnc.flush(false);
  push(ascii('N'));
  push(returnEnc.toBytes());
  push(ascii('SE'));

  push(ascii('FNSE'));

  return Uint8Array.from(bytes);
}
