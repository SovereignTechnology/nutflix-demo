/**
 * Main's side of the host `utilityProcess` (design §1: main "supervises host").
 *
 * - Everything the host sends is checked with L6-0's `isHostOut` before main acts on it
 *   (main is the more privileged side; a media link must be `http://127.0.0.1:<port>/…`).
 * - If the host exits, every call in flight fails `backend-down` (via `onDown`) and the host is
 *   respawned, at most `maxRestarts` times per `windowMs`; after a respawn `onRestart` lets main
 *   reload the window so the renderer re-subscribes against the fresh host.
 *
 * Electron-free: `main.ts` passes `() => utilityProcess.fork(…)`; tests pass a fake child.
 */
import type { HostIn, HostOut } from '../ipc/protocol.js';
import { isHostOut } from '../ipc/guards.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';

/** The `UtilityProcess` members main uses. */
export interface HostChild {
  postMessage(msg: HostIn): void;
  on(event: 'message', listener: (msg: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface HostLinkDeps {
  spawn(): HostChild;
  /** A validated message from the host. */
  onOut(out: HostOut): void;
  /** The host exited (before any respawn). */
  onDown(): void;
  /** A replacement host is running. */
  onRestart(): void;
  now(): number;
  readonly log?: Logger;
  readonly maxRestarts?: number;
  readonly windowMs?: number;
}

export class HostLink {
  private child: HostChild | undefined;
  private stopping = false;
  private restarts: number[] = [];
  private readonly log: Logger;

  constructor(private readonly deps: HostLinkDeps) {
    this.log = deps.log ?? silentLogger;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  start(): void {
    if (this.child !== undefined || this.stopping) return;
    const child = this.deps.spawn();
    this.child = child;
    this.log('info', 'host.spawned');
    child.on('message', (m: unknown) => {
      if (this.child !== child) return;
      if (!isHostOut(m)) {
        this.log('warn', 'host.message-dropped');
        return;
      }
      this.deps.onOut(m);
    });
    child.on('exit', (code: number) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.log(this.stopping ? 'info' : 'error', 'host.exit', { exitCode: code });
      this.deps.onDown();
      if (!this.stopping) this.respawn();
    });
  }

  /** `false` when no host is running (the caller answers `backend-down`). */
  post(msg: HostIn): boolean {
    const child = this.child;
    if (child === undefined) return false;
    try {
      child.postMessage(msg);
      return true;
    } catch {
      this.log('warn', 'host.post-failed');
      return false;
    }
  }

  /**
   * Fix round 4 (app quit): `stop()`, then resolve once the host has exited — it pays the open
   * play sessions' tails first (SIGTERM → `Host.shutdown`) — or after `ms`, whichever is first.
   */
  stopAndWait(ms: number): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.stop();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.stop();
    });
  }

  /** App quit: kill the host and never respawn it. */
  stop(): void {
    this.stopping = true;
    const child = this.child;
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
  }

  private respawn(): void {
    const now = this.deps.now();
    const windowMs = this.deps.windowMs ?? 60_000;
    this.restarts = this.restarts.filter((t) => now - t < windowMs);
    if (this.restarts.length >= (this.deps.maxRestarts ?? 3)) {
      this.log('error', 'host.restart-budget-exhausted', { restarts: this.restarts.length });
      return;
    }
    this.restarts.push(now);
    this.start();
    if (this.child !== undefined) this.deps.onRestart();
  }
}
