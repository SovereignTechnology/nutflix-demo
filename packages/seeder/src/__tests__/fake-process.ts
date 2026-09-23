/** A scripted `SeederProcess` for the daemon-entry tests (stdout captured, signals by hand). */
import type { SeederProcess, SignalName } from '../adapters/process.js';

export class FakeProcess implements SeederProcess {
  readonly argv: readonly string[] = [];
  readonly vars = new Map<string, string>();
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly exits: number[] = [];
  readonly runs: { cmd: string; args: readonly string[] }[] = [];
  private readonly handlers = new Map<SignalName, Set<() => void>>();

  env(name: string): string | undefined {
    return this.vars.get(name);
  }
  writeStdout(line: string): void {
    this.out.push(line);
  }
  writeStderr(line: string): void {
    this.err.push(line);
  }
  onSignal(signal: SignalName, cb: () => void): () => void {
    const set = this.handlers.get(signal) ?? new Set();
    set.add(cb);
    this.handlers.set(signal, set);
    return () => set.delete(cb);
  }
  exit(code: number): void {
    this.exits.push(code);
  }
  run(cmd: string, args: readonly string[]): Promise<{ code: number }> {
    this.runs.push({ cmd, args });
    return Promise.resolve({ code: 0 });
  }
  signal(s: SignalName): void {
    for (const cb of this.handlers.get(s) ?? []) cb();
  }
  /** Everything written, stdout and stderr, as one string (for "value never printed" checks). */
  text(): string {
    return [...this.out, ...this.err].join('\n');
  }
}

/** Poll `cond` on the macrotask queue; fail with `what` after `ms` (no fixed sleeps). */
export async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
