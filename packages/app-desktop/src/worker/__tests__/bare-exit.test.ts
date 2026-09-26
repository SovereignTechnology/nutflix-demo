/**
 * Fix round 4 (I1 verifier, MEDIUM): the worker entry's `Bare.exit` must return while a DLEQ
 * thread is parked. Under Bare, `Bare.exit` joins every live thread and a thread parked in
 * `Atomics.wait` never returns on its own (issue #8 d: the seller's thread lives, parked between
 * jobs, until `providers.close()`), so an uncaught exception after a seller's first PAY used to
 * wedge the worker for good instead of letting the supervisor restart it — the process never
 * exited, and every call failed "did not answer in time".
 *
 * Under the REAL Bare runtime (bare-sidecar's prebuilt `bare`, the product's launch path), with the
 * BUILT, unbundled worker (`dist/worker/…`, one module instance each, as the host runs it in dev):
 * the real `entry.js` installs its handlers, a real `bareDleqThread()` thread starts and answers
 * DLEQ checks (then parks), an uncaught exception is thrown, and the process must exit 1 within a
 * few seconds. Before the fix it was still running 25 s later and had to be SIGKILLed. Skipped
 * when `dist/` lacks the modules (`npm run build` first, as CI does).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MintUrl, payment } from '@sovit/core';
import { mocks } from '@sovit/core';
import Sidecar from 'bare-sidecar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..', '..');
const ROOT = resolve(PKG, '..', '..');
const DIST = join(PKG, 'dist', 'worker');
const built =
  existsSync(join(DIST, 'entry.js')) &&
  existsSync(join(DIST, 'pay', 'dleq-thread-entry.mjs')) &&
  existsSync(join(DIST, 'pay', 'dleq-thread.js')) &&
  existsSync(join(DIST, 'adapters', 'bare.js'));
const MINT = 'https://mint.bare-exit.test' as MintUrl;
/** How long the process may take to exit after the throw (it takes milliseconds when it works). */
const EXIT_WITHIN_MS = 5000;

function checks(n: number): payment.DleqCheck[] {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x5e) });
  const ks = mint.keyset();
  const out: payment.DleqCheck[] = [];
  while (out.length < n)
    for (const proof of mint.issue(15, { p2pk: `02${'3c'.repeat(32)}` })) {
      const key = ks.keys[proof.amount];
      out.push({
        proof,
        keyset: { ...ks, keys: key === undefined ? {} : { [proof.amount]: key } },
      });
    }
  return out.slice(0, n);
}

const href = (p: string): string => JSON.stringify(pathToFileURL(p).href);

/** The program: the real entry, a real thread that answers, then an uncaught exception. */
function program(cs: readonly payment.DleqCheck[]): string {
  return `
const { bareDleqThread } = await import(${href(join(DIST, 'adapters', 'bare.js'))});
const { DleqThread } = await import(${href(join(DIST, 'pay', 'dleq-thread.js'))});
await import(${href(join(DIST, 'entry.js'))});
const t = new DleqThread({ spawn: bareDleqThread() });
const verdicts = await t.verify(${JSON.stringify(cs)});
console.log('BARE-EXIT ' + JSON.stringify({ answered: verdicts.length, ok: verdicts.every((v) => v === true), onThread: t.started }));
setTimeout(() => { throw new Error('an uncaught exception in the worker'); }, 100);
`;
}

let work = '';

beforeAll(async () => {
  if (!built) return;
  // Under the repo's node_modules, so Bare resolves @sovit/* and bare-* from the program.
  work = join(ROOT, 'node_modules', '.cache', `nf-r4-bare-exit-${randomBytes(6).toString('hex')}`);
  await mkdir(work, { recursive: true });
  await writeFile(
    join(work, 'boot.mjs'),
    "import 'bare-encoding/global'\nimport('./main.mjs').catch((e) => { throw e })\n",
  );
  await writeFile(join(work, 'main.mjs'), program(checks(4)));
});

afterAll(async () => {
  if (work !== '') await rm(work, { recursive: true, force: true });
});

describe('the Bare worker exits with a DLEQ thread parked (fix round 4)', () => {
  it.skipIf(!built)(
    'an uncaught exception after the thread answered exits 1 within a few seconds',
    { timeout: 90_000 },
    async () => {
      const sc = new Sidecar(join(work, 'boot.mjs'), []);
      let stdout = '';
      let stderr = '';
      sc.stdout?.on('data', (d: unknown) => {
        if (d instanceof Uint8Array) stdout += Buffer.from(d).toString('utf8');
      });
      sc.stderr?.on('data', (d: unknown) => {
        if (d instanceof Uint8Array) stderr += Buffer.from(d).toString('utf8');
      });
      sc.on('data', () => undefined); // the entry's framed log line (the redacted report)
      sc.on('error', () => undefined);
      const exited = new Promise<number | null>((done) => {
        sc.once('exit', (code: number | null) => {
          done(code);
        });
      });
      // The thread answered: the throw comes 100 ms later.
      const answered = await Promise.race([
        (async (): Promise<number> => {
          for (;;) {
            if (stdout.includes('BARE-EXIT ')) return Date.now();
            await new Promise((r) => setTimeout(r, 20));
          }
        })(),
        exited.then(() => -1),
        new Promise<number>((r) =>
          setTimeout(() => {
            r(-2);
          }, 60_000),
        ),
      ]);
      expect(answered, `no report from bare; stderr: ${stderr.slice(0, 2000)}`).toBeGreaterThan(0);
      const line = stdout.slice(stdout.indexOf('BARE-EXIT ') + 10).split('\n')[0] ?? '';
      expect(JSON.parse(line)).toEqual({ answered: 4, ok: true, onThread: true });
      const code = await Promise.race([
        exited,
        new Promise<'hung'>((r) =>
          setTimeout(() => {
            r('hung');
          }, EXIT_WITHIN_MS + 100),
        ),
      ]);
      // A process wedged in Bare.exit ignores SIGTERM: kill it so the run does not leak it.
      if (code === 'hung')
        (sc as unknown as { _process: { kill(signal: string): boolean } })._process.kill('SIGKILL');
      expect(code).toBe(1);
      expect(Date.now() - answered).toBeLessThan(EXIT_WITHIN_MS);
    },
  );
});
