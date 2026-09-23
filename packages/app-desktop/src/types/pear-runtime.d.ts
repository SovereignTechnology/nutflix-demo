/**
 * Ambient types for `pear-runtime@1.3.1` — exactly the surface the desktop host uses (design
 * §0.5, D2). The package's `exports` names `./index.d.ts` but does not ship it, hence this file.
 * Everything below was read from node_modules (paths relative to it):
 *
 *   pear-runtime/index.js:9-11      `static run(entrypoint, args, opts)` → `require('#run')`
 *   pear-runtime/package.json       `imports['#run']`: `bare` → lib/run/bare.js (bare-worker),
 *                                   default (Node/Electron) → lib/run/default.js
 *   pear-runtime/lib/run/default.js:3-5   `new Sidecar(entrypoint, args, opts)` (bare-sidecar)
 *   bare-sidecar/index.js:14-16     `spawn(<prebuilt bare 1.31.0>, [entry, ...args],
 *                                   { stdio: ['pipe','pipe','pipe','overlapped'] })`
 *   bare-sidecar/index.js:20-22     the duplex is fd 3 of the child (`Bare.IPC` over there)
 *   bare-sidecar/index.js:25-35     `stdin`/`stdout`/`stderr` = the child's stdio pipes
 *   bare-sidecar/index.js:48-50     `destroy()` → `this._process.kill()` (SIGTERM)
 *   bare-sidecar/index.js:53-55     `'exit'` (code, signal) re-emitted from the child
 *   bare-sidecar/index.js:57-59     child `'close'` → `destroy()`
 *   bare-sidecar/index.js:61-65     fd-3 `'end'` → `push(null)` (readable side ends)
 *   bare-sidecar/index.d.ts:4-8     `SidecarEvents.exit: [code, signalCode]`; options `{}`
 *
 * Consequences for the host (L6-B):
 *   - Chunks are Node `Buffer`s (a `Uint8Array` subclass) with NO message boundaries: frame
 *     every message with `src/ipc/framing.ts`.
 *   - The child's stdout/stderr are pipes: DRAIN them (forward to the redacting logger), or the
 *     worker blocks once ~64 KiB of output is buffered.
 *   - `require('pear-runtime')` under Node loads corestore/hyperswarm and their native addons
 *     (sodium-native, rocksdb-native, rabin-native — measured: 239 modules) at import time,
 *     although `run` needs none of it. `bare-sidecar` itself (24 modules, no addon) is the
 *     same `run`; prefer importing it directly if the host must stay addon-free.
 */
declare module 'pear-runtime' {
  /** The child's stdio pipe as the host sees it (a Node `net.Socket` under Node/Electron). */
  export interface PearWorkerStdio {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    resume(): this;
    destroy(): this;
  }

  /**
   * The duplex `PearRuntime.run` returns (a `bare-sidecar` `Sidecar`, bare-stream/streamx
   * based). Writes reach the worker's `Bare.IPC`; the worker's writes arrive as `'data'`.
   */
  export interface PearWorkerIPC {
    write(chunk: Uint8Array, cb?: (err?: Error | null) => void): boolean;
    end(): this;
    /** Kills the child process (SIGTERM). */
    destroy(err?: Error): this;
    readonly destroyed: boolean;
    readonly stdin: PearWorkerStdio | null;
    readonly stdout: PearWorkerStdio | null;
    readonly stderr: PearWorkerStdio | null;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
    once(event: 'data', listener: (chunk: Uint8Array) => void): this;
    once(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
    off(event: string, listener: (...args: never[]) => void): this;
  }

  /**
   * The module's default export as the host may use it. Declared as a value with no construct
   * signature, so `new PearRuntime()` does not compile — D2: NEVER construct a `PearRuntime` in
   * Stage 1. The constructor (index.js:13-28) opens a Corestore and `_open` (index.js:30-42)
   * joins the OTA updater's discovery key on the PUBLIC DHT. OTA is Stage 3.
   */
  export interface PearRuntimeStatic {
    /**
     * Spawns `entrypoint` under the prebuilt `bare` with `args` (the worker sees them at
     * `Bare.argv[2…]`). The third parameter (`opts`) is accepted and ignored by bare-sidecar
     * 0.5.4 (index.js:6-23), so it is not declared. The only pear-runtime API Stage 1 uses.
     */
    run(entrypoint: string, args?: readonly string[]): PearWorkerIPC;
  }

  const PearRuntime: PearRuntimeStatic;
  export default PearRuntime;
}
