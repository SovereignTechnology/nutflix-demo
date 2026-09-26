/**
 * Issue #8 (a) across a REAL crash (ADR 0014 amendment): the host's money plane runs in a child
 * process (`support/journal-crash-child.ts`, bundled here) with its sealed journal on disk, against
 * a TestMint the parent serves over HTTP on 127.0.0.1. When the child's swap (or melt) reaches the
 * mint, the parent lets the mint EXECUTE it and then SIGKILLs the child before any answer — the
 * exact window F31 is about: the journal write done, the mint's answer never seen. A new child
 * over the same profile then settles the journal at open (NUT-09) and spends what came back.
 *
 * And a damaged journal: the child refuses to open the wallet (`journal-unreadable`), the file is
 * byte-for-byte untouched, and once the original bytes are back the same money is recovered.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MintUrl } from '@sovit/core';
import { mocks } from '@sovit/core';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tempDir } from '../../worker/__tests__/helpers/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');

/** The TestMint over HTTP, with a crash switch: `killOn` a POST path runs it, then kills. */
class MintServer {
  mint!: mocks.TestMint;
  url!: MintUrl;
  killOn: string | null = null;
  onKill: (() => void) | null = null;
  private srv: Server | null = null;

  async start(): Promise<void> {
    this.srv = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((r) => this.srv?.listen(0, '127.0.0.1', r));
    const { port } = this.srv.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(port)}` as MintUrl;
    this.mint = new mocks.TestMint({
      url: this.url,
      seed: new Uint8Array(32).fill(0x6b),
      feeReserve: 4,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const c of req) body += (c as Buffer).toString('utf8');
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    try {
      const result = await this.mint.request<Record<string, unknown>>({
        endpoint: `${this.url}${path}`,
        method,
        ...(body.length > 0 ? { requestBody: JSON.parse(body) as Record<string, unknown> } : {}),
      });
      if (method === 'POST' && path.endsWith('/v1/mint/quote/bolt11'))
        this.mint.payQuote(String(result['quote'])); // Lightning is instant here
      if (method === 'POST' && this.killOn !== null && path.endsWith(this.killOn)) {
        // Executed at the mint; the answer never leaves. The client dies waiting for it.
        this.killOn = null;
        this.onKill?.();
        req.socket.destroy();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      res.statusCode = typeof code === 'number' ? 400 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ code: typeof code === 'number' ? code : 0, detail: 'test mint error' }),
      );
    }
  }

  async stop(): Promise<void> {
    const s = this.srv;
    if (s === null) return;
    s.closeAllConnections();
    await new Promise<void>((r) => {
      s.close(() => {
        r();
      });
    });
  }
}

interface Child {
  readonly lines: Record<string, unknown>[];
  readonly exited: Promise<number | null>;
  kill(): void;
  next(
    pred: (l: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
}

let bundleDir = '';
let childFile = '';
const server = new MintServer();

function run(mode: string, dir: string): Child {
  const p = spawn(process.execPath, [childFile, mode, dir, server.url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: Record<string, unknown>[] = [];
  const waiters: { pred: (l: Record<string, unknown>) => boolean; done: () => void }[] = [];
  let buf = '';
  let err = '';
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length === 0) continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
      for (const w of [...waiters]) w.done();
    }
  });
  p.stderr.on('data', (d: Buffer) => {
    err += d.toString('utf8');
  });
  const exited = new Promise<number | null>((r) => {
    p.once('exit', (code) => {
      r(code);
    });
  });
  return {
    lines,
    exited,
    kill: () => p.kill('SIGKILL'),
    next: (pred, ms = 30_000) =>
      new Promise((resolveNext, reject) => {
        const t = setTimeout(() => {
          reject(new Error(`child ${mode}: no matching line in ${String(ms)} ms; stderr: ${err}`));
        }, ms);
        const check = (): void => {
          const hit = lines.find(pred);
          if (hit === undefined) return;
          clearTimeout(t);
          resolveNext(hit);
        };
        waiters.push({ pred, done: check });
        check();
        void exited.then(() => {
          setTimeout(() => {
            check();
          }, 50);
        });
      }),
  };
}

async function journalOf(dir: string): Promise<string> {
  const wallet = join(dir, 'wallet');
  const [name] = (await readdir(wallet)).filter((n) => n.startsWith('journal-'));
  if (name === undefined) throw new Error('no journal file');
  return join(wallet, name);
}

const sha = async (p: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');

beforeAll(async () => {
  await server.start();
  // Bundled under the repo's node_modules so `@sovit/core` & co. resolve from the child's file.
  bundleDir = join(ROOT, 'node_modules', '.cache', `nf-s3res-${randomBytes(6).toString('hex')}`);
  await mkdir(bundleDir, { recursive: true });
  childFile = join(bundleDir, 'child.mjs');
  await build({
    entryPoints: [join(HERE, 'support', 'journal-crash-child.ts')],
    outfile: childFile,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  await server.stop();
  await rm(bundleDir, { recursive: true, force: true });
});

/** A funded profile (64 sat, one proof) in a fresh directory. */
async function funded(): Promise<{ dir: string; rm: () => Promise<void> }> {
  const t = await tempDir('nf-journal-crash-');
  const c = run('fund', t.dir);
  expect(await c.next((l) => 'funded' in l)).toMatchObject({ funded: 64, balance: 64 });
  expect(await c.exited).toBe(0);
  return t;
}

/** Start `mode`, let the mint execute the request on `path`, and kill the child before the answer. */
async function crashDuring(mode: string, path: string, dir: string): Promise<void> {
  const killed = new Promise<void>((r) => {
    server.onKill = r;
  });
  server.killOn = path;
  const c = run(mode, dir);
  await c.next((l) => l['ready'] === true);
  await killed;
  c.kill();
  expect(await c.exited).toBeNull(); // killed by the signal, never exited by itself
  expect(c.lines.some((l) => 'unexpected' in l)).toBe(false);
  server.onKill = null;
}

describe('the desktop wallet journal survives a crash (issue #8, ADR 0014 amendment)', () => {
  it(
    'a send killed between the journal write and the mint answer is recovered at the next start',
    { timeout: 90_000 },
    async () => {
      const t = await funded();
      try {
        const swapsBefore = server.mint.calls.filter((c) => c === 'POST /v1/swap').length;
        await crashDuring('send', '/v1/swap', t.dir);
        expect(server.mint.calls.filter((c) => c === 'POST /v1/swap').length).toBe(swapsBefore + 1);
        // The journal is on disk, sealed (0600) — the entry was durable before the request left.
        const j = await journalOf(t.dir);
        expect((await stat(j)).mode & 0o777).toBe(0o600);
        const text = await readFile(j, 'utf8');
        expect(text).not.toMatch(/"blindingFactor"|"secret"|"spends"/);

        const c = run('recover', t.dir);
        const r = await c.next((l) => 'settled' in l);
        expect(await c.exited).toBe(0);
        expect(r['settled']).toEqual({ recovered: 1, left: 0 });
        expect(r['balance']).toBe(61); // 64 − 3, the change restored by NUT-09
        expect(r['history']).toContainEqual(
          expect.objectContaining({ direction: 'out', amount: 3 }),
        );
        expect(r['spentAll']).toBe(true); // the mint took them: real, and spent only now
        expect(r['after']).toBe(0);
      } finally {
        await t.rm();
      }
    },
  );

  it(
    'a melt killed mid-request gets its change back at the next start (melt change is journaled)',
    { timeout: 90_000 },
    async () => {
      const t = await funded();
      try {
        await crashDuring('melt', '/v1/melt/bolt11', t.dir);
        const c = run('recover', t.dir);
        const r = await c.next((l) => 'settled' in l);
        expect(await c.exited).toBe(0);
        expect(r['settled']).toEqual({ recovered: 1, left: 0 });
        expect(r['balance']).toBe(44); // 64 − 20: the fee reserve came back as change
        expect(r['history']).toContainEqual(
          expect.objectContaining({ direction: 'out', amount: 20 }),
        );
        expect(r['spentAll']).toBe(true);
      } finally {
        await t.rm();
      }
    },
  );

  it(
    'a damaged journal refuses the wallet loudly and is kept byte for byte; the original bytes still recover',
    { timeout: 90_000 },
    async () => {
      const t = await funded();
      try {
        await crashDuring('send', '/v1/swap', t.dir);
        const j = await journalOf(t.dir);
        const original = await readFile(j);
        const env = JSON.parse(original.toString('utf8')) as { box: string };
        const damaged = JSON.stringify({
          ...env,
          box: (env.box.startsWith('0') ? '1' : '0') + env.box.slice(1),
        });
        await writeFile(j, damaged, { mode: 0o600 });
        const before = await sha(j);

        const c = run('recover', t.dir);
        expect(await c.next((l) => 'openError' in l)).toEqual({ openError: 'journal-unreadable' });
        expect(await c.exited).toBe(3);
        expect(await sha(j)).toBe(before); // never overwritten, never dropped

        await writeFile(j, original, { mode: 0o600 });
        const again = run('recover', t.dir);
        const r = await again.next((l) => 'settled' in l);
        expect(r['settled']).toEqual({ recovered: 1, left: 0 });
        expect(r['balance']).toBe(61);
        expect(await again.exited).toBe(0);
      } finally {
        await t.rm();
      }
    },
  );
});
