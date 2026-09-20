/** 1-Wire/Dallas CRC-8 (poly 0x8C, LSB-first) over the given bytes. */
export function oneWireCrc(bytes: Iterable<number>): number;

export const VENDOR_ID: number;
export const PRODUCT_ID: number;

export const Status: Readonly<{
  OK: number;
  BUFFER_FULL: number;
  CRC_ERROR: number;
  TASK_COMPLETE: number;
  TASK_COMPLETE_M3: number;
  UNKNOWN_2: number;
}>;

/** Build a framed 34-byte packet from up to 30 payload bytes (or an ASCII string). */
export function buildPacket(payload: string | Iterable<number>): Uint8Array;

export const HELLO_PACKET: Uint8Array;
export const UNLOCK_PACKET: Uint8Array;
export const HOME_PACKET: Uint8Array;
export const ESTOP_PACKET: Uint8Array;

export interface SendJobOptions {
  signal?: AbortSignal;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

export class K40Transport {
  constructor(options?: { timeoutMs?: number; maxRetries?: number });

  timeoutMs: number;
  maxRetries: number;

  readonly connected: boolean;

  /**
   * Resolves with the underlying WebUSB `USBDevice` (typed `unknown` here so
   * this declaration doesn't depend on WebUSB lib types being configured in
   * the consumer's tsconfig — cast as needed, e.g. for `productName`).
   */
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;

  hello(): Promise<number | null>;
  sendPacket(packet: Uint8Array): Promise<number | null>;
  waitForFinish(): Promise<number>;

  /**
   * Send a full LHYMICRO-GL byte stream, chunked/framed/verified
   * packet-by-packet, then block until the controller reports completion.
   * See `SendJobOptions` for cancellation/progress.
   */
  sendJob(bytes: Iterable<number>, options?: SendJobOptions): Promise<void>;

  unlock(): Promise<number | null>;
  home(): Promise<number | null>;
  estop(): Promise<number | null>;
}

export const LaserSpeed: {
  getSpeedFromCode(speedCode: string, board?: string): number;
  getCodeFromSpeed(
    mmPerSecond: number,
    rasterStep?: number,
    board?: string,
    dRatio?: number,
    gear?: number | null,
  ): string;
};

export const Opcode: Readonly<{
  RIGHT: number;
  LEFT: number;
  UP: number;
  DOWN: number;
  ANGLE: number;
  LASER_ON: number;
  LASER_OFF: number;
}>;

/** Encode a distance in mils as LHYMICRO-GL distance bytes (char codes). */
export function encodeDistance(distMils: number): number[];

export class LhymicroEncoder {
  move(
    direction: number,
    distance: number,
    laserOn?: boolean,
    angleDirs?: [number, number] | null,
  ): void;
  flush(laserOn?: boolean | null): void;
  makeDirDist(dxMils: number, dyMils: number, laserOn?: boolean): void;
  makeCutLine(dxMils: number, dyMils: number, laserOn: boolean): void;
  toBytes(): Uint8Array;
  drain(): number[];
  writeRaw(bytes: number | number[]): void;
  changeSpeed(
    feedMmPerSec: number,
    board: string,
    laserOn?: boolean,
    rasterStep?: number,
    pad?: boolean,
  ): void;
}

export function makeSpeed(feedMmPerSec: number, board?: string, rasterStep?: number): number[];

export interface VectorPath {
  points: [number, number][];
  feedMmPerSec?: number;
}

export interface BuildVectorJobOptions {
  paths: (([number, number][]) | VectorPath)[];
  feedMmPerSec: number;
  board?: string;
}

export function buildVectorJob(options: BuildVectorJobOptions): Uint8Array;

export interface BuildRasterJobOptions {
  rows: [number, number][][];
  rowStepMils: number;
  feedMmPerSec: number;
  board?: string;
}

export function buildRasterJob(options: BuildRasterJobOptions): Uint8Array;

export interface BuildJogJobOptions {
  dxMils: number;
  dyMils: number;
  feedMmPerSec: number;
  board?: string;
}

export function buildJogJob(options: BuildJogJobOptions): Uint8Array;
