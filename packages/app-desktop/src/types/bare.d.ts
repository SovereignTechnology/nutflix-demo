/**
 * Ambient `Bare` global for the desktop worker — only the surface L6 uses. There is no types
 * package for the Bare global in node_modules; everything here was read from the runtime
 * itself and checked by running it (docs/lanes/L6-0.md "Bare globals"):
 *
 *   Bare 1.31.0 runtime, bundled into node_modules/bare-sidecar/prebuilds/<platform>/bare as
 *   module `/src/bare.js`: `class Bare extends EventEmitter` with getters `platform`, `arch`,
 *   `argv`, `pid`, `exitCode` (setter masks `& 0xff`), `version`, `versions`; methods `exit`,
 *   `suspend`, `wakeup`, `idle`, `resume`; lifecycle events `uncaughtException`,
 *   `unhandledRejection`, `beforeExit`, `exit`, `suspend`, `wakeup`, `idle`, `resume`
 *   (an unhandled `uncaughtException`/`unhandledRejection` ABORTS the process). Globals it
 *   installs: `queueMicrotask`, `Buffer`, timers, `structuredClone`, `URL`, `console` — and
 *   NOT `TextEncoder`, `TextDecoder`, `crypto`, `AbortController`, `process`, `fetch`,
 *   `WebSocket`, `performance`, `EventTarget` (verified with `typeof` under the binary).
 *
 *   node_modules/bare-sidecar/lib/runtime.js (the sidecar entry wrapper):
 *     :6      `const ipc = new Pipe(3)` — fd 3, a bare-pipe Duplex
 *     :8-30   while no user `'close'` listener is attached, the pipe closing calls `Bare.exit()`;
 *             attaching one removes that — the worker must then exit by itself
 *     :32     `Bare.IPC = ipc`
 *     :40-42  `Bare.argv[1]` is rewritten to the resolved entry path
 *
 * `Bare.argv` = [bare binary, entry script, ...args passed to `PearRuntime.run`].
 * This file is included ONLY by tsconfig.worker.json. `src/ipc/` must not use `Bare`
 * (`src/ipc/__tests__/boundaries.test.ts`).
 */

/** `Bare.IPC`: the worker's end of the host duplex (bare-pipe `Pipe` over fd 3). */
interface BareIPC {
  /** Chunks arrive as bare-buffer `Buffer`s (a `Uint8Array` subclass), unframed. */
  write(chunk: Uint8Array, cb?: (err: Error | null) => void): boolean;
  end(): this;
  destroy(err?: Error): this;
  /** Unref so an idle pipe does not keep the worker alive (bare-pipe `unref`). */
  unref(): this;
  ref(): this;
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  once(event: 'data', listener: (chunk: Uint8Array) => void): this;
  once(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
}

interface BareEventMap {
  exit: [code: number];
  beforeExit: [code: number];
  uncaughtException: [err: unknown];
  unhandledRejection: [reason: unknown, promise: Promise<unknown>];
  suspend: [linger: number];
  wakeup: [deadline: number];
  idle: [];
  resume: [];
}

interface BareRuntime {
  readonly platform: string;
  readonly arch: string;
  /** [bare binary, entry script, ...the args passed to `PearRuntime.run`]. */
  readonly argv: readonly string[];
  readonly pid: number;
  /** Masked to 0..255 on assignment. */
  exitCode: number;
  /** e.g. `v1.31.0`. */
  readonly version: string;
  readonly versions: Readonly<Record<string, string>>;
  /** Set by bare-sidecar's runtime wrapper; `null` when not launched through a sidecar. */
  readonly IPC: BareIPC | null;
  exit(code?: number): never;
  on<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
  once<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
  off<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
}

declare const Bare: BareRuntime;
