/**
 * LHYMICRO-GL: the byte-opcode job language the M2-Nano executes.
 *
 * Ported from egv.py's `egv` class (move/flush/make_distance/make_dir_dist/
 * make_cut_line/make_egv_data/rapid_move_fast). This covers straight-line
 * vector cutting, including multi-path jobs with dogleg-optimized travel
 * between paths; it does NOT yet port raster jobs, mid-job speed changes
 * (change_speed), or the temporary-rapid-feed travel mode (rapid_move_slow)
 * — see _dev/webapp.md §6 in k40-control for what those do in the original.
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

  /**
   * Return and clear the buffered bytes so far, leaving modal state (the
   * current direction/laser/axis tracking) untouched. Used to splice raw,
   * non-modal framing bytes (e.g. a dogleg travel move) into the middle of
   * an otherwise-continuous modal byte stream, matching how egv.py's `self`
   * keeps a single running encoder across arbitrary `self.write()` calls.
   */
  drain() {
    const codes = this.#codes;
    this.#codes = [];
    return codes;
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

// Below this threshold (in either axis) a non-cutting move is short enough
// that the dogleg detour would cost more than it saves, so it's just sent
// as a plain move instead — the `min_rapid` check in make_egv_data().
const MIN_RAPID_MILS = 5;

/**
 * Dogleg-shaped rapid travel move: briefly overshoot away from the cut —
 * backward on X, then away on Y — before covering the remaining distance,
 * so a long non-cutting move doesn't drag the head back across material
 * that's still in its path. Emits its own self-contained raw framing
 * (`<dir> N <move> S E`), independent of any surrounding modal encoder
 * state — ported from `rapid_move_fast()` in egv.py.
 *
 * @param {number} dxMils
 * @param {number} dyMils
 * @returns {number[]} char codes
 */
function rapidMoveFast(dxMils, dyMils) {
  let pad = 3;
  if (pad === -dxMils) pad += 3;

  const bytes = [];

  const padEnc = new LhymicroEncoder();
  padEnc.makeDirDist(-pad, 0, false);
  padEnc.makeDirDist(0, pad, false);
  padEnc.flush(false);
  bytes.push(...padEnc.toBytes());

  // Re-prime the direction state (no distance follows) before the raw "N"
  // move section, matching the header's own direction-priming dance.
  bytes.push(dxMils + pad < 0 ? Opcode.RIGHT : Opcode.LEFT);
  bytes.push(...ascii('N'));

  const moveEnc = new LhymicroEncoder();
  moveEnc.makeDirDist(dxMils + pad, dyMils - pad, false);
  moveEnc.flush(false);
  bytes.push(...moveEnc.toBytes());

  bytes.push(...ascii('SE'));
  return bytes;
}

/**
 * Build a complete vector-cut job: speed code, header, one or more cut
 * paths (straight/diagonal segments through each path's points in order),
 * and a return move + footer — the `Raster_step == 0` branch of
 * `make_egv_data()` in egv.py, minus mid-job speed changes.
 *
 * Laser-off travel — between paths, and the final move back to the job's
 * starting position — uses a plain move when short, or a dogleg-optimized
 * rapid move (`rapid_move_fast`) when long enough that dragging the head
 * straight through material in its path would matter.
 *
 * @param {object} opts
 * @param {[number, number][][]} opts.paths one array per cut path, each an
 *   array of vertices in mils, relative to the machine's current position
 *   (paths[0][0]) or the previous path's last point (paths[n>0][0]); each
 *   path's first point is a laser-off travel move, the rest are cut with
 *   the laser on. Every path needs at least 2 points.
 * @param {number} opts.feedMmPerSec
 * @param {string} [opts.board='M2']
 * @returns {Uint8Array} bytes ready for `K40Transport#sendJob()`
 */
export function buildVectorJob({ paths, feedMmPerSec, board = 'M2' }) {
  if (!paths || paths.length === 0) {
    throw new Error('buildVectorJob: need at least one path');
  }
  paths.forEach((path, i) => {
    if (path.length < 2) {
      throw new Error(`buildVectorJob: path ${i} needs a start point and at least one cut point`);
    }
  });

  const bytes = [];
  const push = (arr) => bytes.push(...arr);

  push(makeSpeed(feedMmPerSec, board, 0));

  // Initial travel move (laser off) from the current head position to the
  // first path's first vertex. Points are mils, relative to that starting
  // position. This header move is always plain, even for a long distance —
  // egv.py only dogleg-optimizes travel that happens mid-job.
  const [startX, startY] = paths[0][0];
  const headerEnc = new LhymicroEncoder();
  headerEnc.makeDirDist(startX, startY, false);
  headerEnc.flush(false);
  push(headerEnc.toBytes());

  push(ascii('N'));
  push([startY <= 0 ? Opcode.DOWN : Opcode.UP]);
  push([startX >= 0 ? Opcode.RIGHT : Opcode.LEFT]);
  push(ascii('S1E'));

  // A single continuous modal encoder for everything from here to the
  // footer — cuts, plain in-between travel, and the pad moves inside a
  // dogleg — matching egv.py's single `self` instance across the whole job.
  const enc = new LhymicroEncoder();
  let lastX = startX;
  let lastY = startY;

  const travelTo = (x, y) => {
    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x;
    lastY = y;
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) < MIN_RAPID_MILS && Math.abs(dy) < MIN_RAPID_MILS) {
      enc.makeDirDist(dx, dy, false);
    } else {
      enc.flush(false);
      push(enc.drain());
      push(rapidMoveFast(dx, dy));
    }
  };

  for (let p = 0; p < paths.length; p++) {
    const path = paths[p];
    if (p > 0) {
      const [x, y] = path[0];
      travelTo(x, y);
    }
    for (let i = 1; i < path.length; i++) {
      const [x, y] = path[i];
      enc.makeCutLine(x - lastX, y - lastY, true);
      lastX = x;
      lastY = y;
    }
  }

  // Travel move back to the job's starting position (mils 0,0), optimized
  // the same way as travel between paths.
  travelTo(0, 0);

  enc.flush(false);
  push(enc.toBytes());

  push(ascii('FNSE'));

  return Uint8Array.from(bytes);
}
