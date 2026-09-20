/**
 * LHYMICRO-GL: the byte-opcode job language the M2-Nano executes.
 *
 * Ported from egv.py's `egv` class (move/flush/make_distance/make_dir_dist/
 * make_cut_line/make_egv_data/rapid_move_fast/change_speed). This covers
 * straight-line vector cutting (including multi-path jobs with
 * dogleg-optimized travel and mid-job speed changes between paths) and
 * raster (image engraving) jobs; it does NOT yet port raster mid-job speed
 * changes, the temporary-rapid-feed travel mode (rapid_move_slow/
 * raster_rapid_move_slow — both depend on change_speed), or the raster
 * path's blank-row jump-ahead optimization (multiple blank rows collapsed
 * into one Y move) — see _dev/webapp.md §6 in k40-control for what those do
 * in the original.
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

  /**
   * Append raw byte(s) straight to the output, bypassing modal tracking
   * entirely — matching egv.py's `self.write()`, which is used both for
   * tracked codes (from `move()`/`flush()`) and untracked framing bytes.
   * Used by `changeSpeed()` for framing that must land in the byte stream
   * without affecting `move()`'s modal direction/laser bookkeeping.
   * @param {number|number[]} bytes
   */
  writeRaw(bytes) {
    if (Array.isArray(bytes)) {
      this.#codes.push(...bytes);
    } else {
      this.#codes.push(bytes);
    }
  }

  /**
   * Emit a mid-job speed change: a small pad move bracketing a "@NSE"
   * motion-state reset, a new speed code, and a re-primed "NRB S1E" start
   * marker — ported from `change_speed()` in egv.py.
   *
   * If `laserOn` is true (changing speed mid-cut), the laser is forced off
   * for the reset via a raw, untracked byte — matching egv.py, this
   * leaves modal laser-state tracking momentarily stale, so the next
   * tracked move that turns the laser back on emits its own redundant
   * on/off byte; harmless on the wire, but not worth "fixing" out of a
   * faithful port. Calling this between paths, with the laser already off
   * (`laserOn=false`), avoids that redundancy entirely.
   *
   * @param {number} feedMmPerSec
   * @param {string} board
   * @param {boolean} [laserOn=false] whether the laser is on going into
   *   (and should resume after) this call
   * @param {number} [rasterStep=0]
   * @param {boolean} [pad=true]
   */
  changeSpeed(feedMmPerSec, board, laserOn = false, rasterStep = 0, pad = true) {
    const cspad = 5;
    if (laserOn) this.writeRaw(Opcode.LASER_OFF);
    if (pad) this.makeDirDist(-cspad, -cspad, false);
    this.flush(false);
    this.writeRaw(ascii('@NSE'));
    this.writeRaw(makeSpeed(feedMmPerSec, board, rasterStep));
    this.writeRaw(ascii('NRBS1EU'));
    if (pad) this.makeDirDist(cspad, cspad, false);
    this.flush(false);
    if (laserOn) this.writeRaw(Opcode.LASER_ON);
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
 * `make_egv_data()` in egv.py.
 *
 * Laser-off travel — between paths, and the final move back to the job's
 * starting position — uses a plain move when short, or a dogleg-optimized
 * rapid move (`rapid_move_fast`) when long enough that dragging the head
 * straight through material in its path would matter.
 *
 * A path may override the job's feed rate; when a path's effective feed
 * differs from the previous one, a mid-job speed change (`change_speed()`
 * in egv.py) is emitted between the travel move to that path and its first
 * cut, so each path is cut at its own speed.
 *
 * @param {object} opts
 * @param {(([number, number][])|{points: [number, number][], feedMmPerSec: number})[]} opts.paths
 *   one entry per cut path: either a plain array of vertices (cut at the
 *   job's `feedMmPerSec`), or `{ points, feedMmPerSec }` to cut that path at
 *   a different feed rate. Vertices are mils, relative to the machine's
 *   current position (paths[0].points[0]) or the previous path's last point
 *   (paths[n>0].points[0]); each path's first point is a laser-off travel
 *   move, the rest are cut with the laser on. Every path needs at least 2
 *   points.
 * @param {number} opts.feedMmPerSec default feed rate for paths that don't
 *   specify their own
 * @param {string} [opts.board='M2']
 * @returns {Uint8Array} bytes ready for `K40Transport#sendJob()`
 */
export function buildVectorJob({ paths, feedMmPerSec, board = 'M2' }) {
  if (!paths || paths.length === 0) {
    throw new Error('buildVectorJob: need at least one path');
  }
  const normalizedPaths = paths.map((entry) =>
    Array.isArray(entry) ? { points: entry, feedMmPerSec } : { feedMmPerSec, ...entry },
  );
  normalizedPaths.forEach(({ points }, i) => {
    if (!points || points.length < 2) {
      throw new Error(`buildVectorJob: path ${i} needs a start point and at least one cut point`);
    }
  });

  const bytes = [];
  const push = (arr) => bytes.push(...arr);

  let currentFeed = normalizedPaths[0].feedMmPerSec;
  push(makeSpeed(currentFeed, board, 0));

  // Initial travel move (laser off) from the current head position to the
  // first path's first vertex. Points are mils, relative to that starting
  // position. This header move is always plain, even for a long distance —
  // egv.py only dogleg-optimizes travel that happens mid-job.
  const [startX, startY] = normalizedPaths[0].points[0];
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

  for (let p = 0; p < normalizedPaths.length; p++) {
    const { points, feedMmPerSec: pathFeed } = normalizedPaths[p];
    if (p > 0) {
      const [x, y] = points[0];
      travelTo(x, y);
      if (pathFeed !== currentFeed) {
        // Laser is off here (we just finished travelling to this path's
        // start), so this never hits the mid-cut redundant on/off bytes —
        // see LhymicroEncoder#changeSpeed.
        enc.changeSpeed(pathFeed, board, false);
        currentFeed = pathFeed;
      }
    }
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
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

/**
 * Build a complete raster (image engraving) job: a speed code with an
 * embedded raster step, a "swing"-mode header, boustrophedon (alternating
 * left/right) scanning of each row with the small backlash-compensation
 * "pad" move at each direction reversal, and a return move + footer — the
 * `Raster_step != 0` branch of `make_egv_data()` in egv.py, minus its
 * blank-row jump optimization (`adj_steps`), `Rapid_Feed_Rate` travel mode,
 * and `FlipXoffset` mirroring.
 *
 * The controller itself steps the Y axis by exactly `rowStepMils` (per the
 * `G<step>` suffix in the raster speed code) each time the horizontal scan
 * direction reverses, so this function never emits an explicit Y move
 * within a row — only once, in the final return-to-start move.
 *
 * @param {object} opts
 * @param {[number, number][][]} opts.rows one entry per scan line, top to
 *   bottom; each entry is an ascending, non-overlapping array of
 *   `[xStartMils, xEndMils]` laser-on intervals for that row, relative to a
 *   shared X origin. Every row must have at least one interval — this does
 *   not port egv.py's handling of blank rows.
 * @param {number} opts.rowStepMils distance between rows, mils; sign
 *   selects the controller's raster scan orientation ("L" if >= 0, "R" if
 *   < 0), matching `Raster_step`'s sign in egv.py.
 * @param {number} opts.feedMmPerSec
 * @param {string} [opts.board='M2']
 * @returns {Uint8Array} bytes ready for `K40Transport#sendJob()`
 */
export function buildRasterJob({ rows, rowStepMils, feedMmPerSec, board = 'M2' }) {
  if (rows.length === 0) {
    throw new Error('buildRasterJob: need at least one row');
  }
  if (rowStepMils === 0) {
    throw new Error('buildRasterJob: rowStepMils must be non-zero');
  }

  // Flatten each row's [start, end] intervals into an ascending list of
  // (x, loop) points, where two consecutive points sharing a loop id are a
  // laser-on cut (the interval itself) and points from different loop ids
  // are a laser-off positioning move — ported from the `scanline`/`loop`
  // bookkeeping in make_egv_data()'s raster branch.
  const rowPoints = rows.map((intervals, row) => {
    const points = intervals.flatMap((iv, idx) => [
      { x: iv[0], loop: idx },
      { x: iv[1], loop: idx },
    ]);
    if (points.length === 0) {
      throw new Error(`buildRasterJob: row ${row} has no burn intervals`);
    }
    return points;
  });

  const bytes = [];
  const push = (arr) => bytes.push(...arr);

  push(makeSpeed(feedMmPerSec, board, rowStepMils));

  // Initial travel move (laser off) to the first row's entry point (its
  // leftmost point, since the first row always scans left-to-right).
  let lastX = rowPoints[0][0].x;
  const headerEnc = new LhymicroEncoder();
  headerEnc.makeDirDist(lastX, 0, false);
  headerEnc.flush(false);
  push(headerEnc.toBytes());

  push(ascii('N'));
  push(ascii(rowStepMils < 0 ? 'R' : 'L'));
  push(ascii('B'));
  push(ascii('S1E'));

  const cutEnc = new LhymicroEncoder();
  const pad = 2;
  let sign = -1;
  let trackedY = 0;

  for (let i = 0; i < rowPoints.length; i++) {
    sign = -sign;
    const points = sign === 1 ? rowPoints[i] : rowPoints[i].slice().reverse();

    const xr = points[0].x;
    const dxr = xr - lastX;
    if (i > 0 && dxr * sign <= 0) {
      // Backlash-compensation dance: overshoot opposite the new scan
      // direction, travel the full distance, then re-overshoot forward —
      // nets out to `dxr` but preloads the stepper before the reversal.
      // Ported from the `Rapid_flag == False` row-end padding branch.
      cutEnc.makeDirDist(-sign * pad, 0, false);
      cutEnc.makeDirDist(dxr, 0, false);
      cutEnc.makeDirDist(sign * pad, 0, false);
      lastX += dxr;
    }

    let lastLoop = null;
    for (const pt of points) {
      const dx = pt.x - lastX;
      if (pt.loop === lastLoop) {
        cutEnc.makeCutLine(dx, 0, true);
      } else if (dx * sign > 0) {
        cutEnc.makeDirDist(dx, 0, false);
      }
      lastX = pt.x;
      lastLoop = pt.loop;
    }
  }

  // Final move to ensure the head ends up to the right, matching egv.py;
  // if the last row scanned right-to-left, the controller will have
  // stepped Y once more on this reversal.
  cutEnc.makeDirDist(pad, 0, false);
  lastX += pad;
  if (sign < 0) trackedY += rowStepMils;
  cutEnc.flush(false);
  push(cutEnc.toBytes());

  // Plain (non-optimized) travel move back to the job's starting position.
  const dxFinal = -lastX;
  const dyFinal = rowStepMils < 0 ? -trackedY + rowStepMils : -trackedY - rowStepMils;
  const returnEnc = new LhymicroEncoder();
  returnEnc.makeDirDist(dxFinal, dyFinal, false);
  returnEnc.flush(false);
  push(ascii('N'));
  push(returnEnc.toBytes());
  push(ascii('SE'));

  push(ascii('FNSE'));

  return Uint8Array.from(bytes);
}
