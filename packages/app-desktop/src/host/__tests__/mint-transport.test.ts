/**
 * Issue #8, fix round 2 (independent verifier, HIGH): the desktop money plane reaches its mints
 * through a SINGLE-ATTEMPT transport by default. Before, `MoneyPlane` built its
 * `CashuMintConnections` with no request function in production, so cashu-ts used its own fetch
 * transport — which retries `/v1/swap`, `/v1/melt/bolt11` and `/v1/mint/bolt11` after a network
 * error or a 5xx, up to 9 times within the ttl, when the mint advertises NUT-19 (cdk-mintd does,
 * ttl 60). A retry's answer says nothing about the first attempt: a 429 or a coded error on the
 * retry of a swap that had executed dropped the journal entry and lost the outputs.
 *
 * Here the money plane is opened with NO `mintRequest` (what `createHost` does in production) over
 * real HTTP to a local mint (the in-process TestMint behind `node:http`) that advertises NUT-19
 * like cdk-mintd. The first POST /v1/swap executes and its connection drops before the answer; any
 * later one is answered 429. One attempt reaches the mint, never a retry, and the send completes
 * from the journal (NUT-09) — nothing lost.
 *
 * Fix round 3 (verifier, LOW): that transport's 30 s whole-exchange timeout also cut off a melt,
 * where the mint pays the invoice before it answers (a Lightning payment can take a minute or
 * more). Over a local mint that holds its answers and fake timers: a melt answered after 45 s
 * succeeds and gives up only at 300 s; quotes, swaps and quote checks still time out at 30 s.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPubKeyFromPrivKey, MintOperationError } from '@cashu/cashu-ts';
import type { CashuP2pkPubkey, MintUrl, RelayUrl, Sats } from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MELT_REQUEST_TIMEOUT_MS, MINT_REQUEST_TIMEOUT_MS } from '../../ipc/deadlines.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { hostMintRequest } from '../mint-transport.js';
import { WALLET_DIR } from '../wallet-journal.js';

const RELAY = 'wss://relay.mint-transport.test' as RelayUrl;
const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x4d))).toString(
  'hex',
) as CashuP2pkPubkey;

let dir: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-mint-transport-'));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A TestMint over real HTTP on 127.0.0.1, advertising NUT-19 like cdk-mintd 0.18.1. With
 * `loseFirstSwap`, the first POST /v1/swap is executed and its connection destroyed before the
 * answer, and every later POST /v1/swap is answered 429 (a rate limiter in front of the mint).
 */
async function httpMint(): Promise<{
  url: MintUrl;
  mint: mocks.TestMint;
  st: {
    loseFirstSwap: boolean;
    swapPosts: number;
    served429: number;
    /** Every request's `Accept` and `User-Agent` (cashu-ts's fetch transport sends both). */
    headers: { accept?: string; ua?: string }[];
  };
}> {
  const st = {
    loseFirstSwap: false,
    swapPosts: 0,
    served429: 0,
    headers: [] as { accept?: string; ua?: string }[],
  };
  // Set once the server listens (the mint's URL is the server's).
  const at: { mint?: mocks.TestMint; base: string } = { base: '' };
  const answer = async (req: IncomingMessage, res: ServerResponse, text: string): Promise<void> => {
    st.headers.push({
      ...(req.headers.accept === undefined ? {} : { accept: req.headers.accept }),
      ...(req.headers['user-agent'] === undefined ? {} : { ua: req.headers['user-agent'] }),
    });
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    const isSwap = method === 'POST' && path === '/v1/swap';
    if (isSwap) {
      st.swapPosts++;
      if (st.loseFirstSwap && st.swapPosts > 1) {
        st.served429++;
        res.writeHead(429, { 'Retry-After': '1' });
        res.end();
        return;
      }
    }
    const mint = at.mint;
    if (mint === undefined) throw new Error('no mint yet');
    let status = 200;
    let out: unknown;
    try {
      out = await mint.request({
        endpoint: `${at.base}${path}`,
        method,
        ...(text === '' ? {} : { requestBody: JSON.parse(text) as Record<string, unknown> }),
      });
    } catch (e) {
      const coded = e instanceof MintOperationError;
      status = coded ? 400 : 500;
      out = coded ? { code: e.code, detail: e.message } : { detail: 'error' };
    }
    if (isSwap && st.loseFirstSwap && st.swapPosts === 1) {
      req.socket.destroy(); // the mint has run it; the answer never arrives
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void answer(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`;
  at.base = base;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => {
          r();
        });
      }),
  );
  const mint = new mocks.TestMint({
    url: base as MintUrl,
    seed: new Uint8Array(32).fill(0x4e),
    nut19: {
      ttl: 60,
      cachedEndpoints: [
        { method: 'POST', path: '/v1/swap' },
        { method: 'POST', path: '/v1/mint/bolt11' },
        { method: 'POST', path: '/v1/melt/bolt11' },
      ],
    },
  });
  at.mint = mint;
  return { url: base as MintUrl, mint, st };
}

describe('the money plane’s default mint transport sends each request once (fix round 2)', () => {
  it('no mintRequest (production): a lost swap answer is not retried into a 429; the send completes from the journal', async () => {
    const { url, mint, st } = await httpMint();
    const signer = (
      await signerMod.LocalSigner.create({
        passphrase: Buffer.from('mint transport passphrase'),
        cost: signerMod.minimumCost(),
      })
    ).signer;
    const plane = await MoneyPlane.open({
      signer,
      pool: new nostr.FakeRelayPool(),
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [url],
      log: memoryLogger('warn'),
      journalDir: join(dir, WALLET_DIR),
      tailDir: null, // in memory: not about tail authorisations
      createWallet: true,
      // no mintRequest: the host's own default
    });
    try {
      await plane.recovery;
      const q = await plane.wallet.mintQuote(url, 32 as Sats);
      mint.payQuote(q.quoteId);
      await plane.wallet.pollQuote(q);
      expect(await plane.wallet.balance(url)).toBe(32);
      st.loseFirstSwap = true;
      const set = await plane.wallet.send(4 as Sats, { p2pk: TO, mint: url });
      expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(4);
      // One attempt reached the mint; nothing retried it into the rate limiter.
      expect(st.swapPosts).toBe(1);
      expect(st.served429).toBe(0);
      expect(await plane.wallet.balance(url)).toBe(28);
      expect(mint.calls.filter((c) => c === 'POST /v1/restore').length).toBeGreaterThan(0);
      expect(st.headers.every((h) => h.accept === 'application/json' && h.ua === undefined)).toBe(
        true,
      );
    } finally {
      plane.close();
    }
  });

  it('a mint an injected (test) transport leaves out gets the host transport too, never cashu-ts’s fetch', async () => {
    const { url, st } = await httpMint();
    const signer = (
      await signerMod.LocalSigner.create({
        passphrase: Buffer.from('mint transport passphrase'),
        cost: signerMod.minimumCost(),
      })
    ).signer;
    const plane = await MoneyPlane.open({
      signer,
      pool: new nostr.FakeRelayPool(),
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [url],
      log: memoryLogger('warn'),
      journalDir: join(dir, WALLET_DIR),
      tailDir: null, // in memory: not about tail authorisations
      createWallet: true,
      mintRequest: () => undefined,
    });
    try {
      expect(await plane.wallet.inputFeePpk(url)).toBe(0);
      // cashu-ts's fetch transport sends `Accept: application/json, text/plain, */*` and a
      // User-Agent; the host's (`cashuRequestFn`) sends `Accept: application/json` and none.
      // Core's own default since fix round 3, `cashuRequestFn` over `fetch`, adds Node's
      // `User-Agent: node`, so this also tells the host transport from that one.
      expect(st.headers.length).toBeGreaterThan(0);
      expect(st.headers.every((h) => h.accept === 'application/json' && h.ua === undefined)).toBe(
        true,
      );
    } finally {
      plane.close();
    }
  });

  it('hostMintRequest: one call per request even when cashu-ts passes the mint’s NUT-19 ttl and cached endpoints', async () => {
    const { url, st } = await httpMint();
    st.loseFirstSwap = true;
    const request = hostMintRequest();
    await expect(
      request({
        endpoint: `${url}/v1/swap`,
        method: 'POST',
        requestBody: { inputs: [], outputs: [] },
        ttl: 60_000,
        cached_endpoints: [{ method: 'POST', path: '/v1/swap' }],
      }),
    ).rejects.toMatchObject({ name: 'NetworkError' });
    expect(st.swapPosts).toBe(1);
  });

  it('the money plane is the only way the desktop reaches a mint: one CashuMintConnections, given a request; no cashu-ts elsewhere', async () => {
    // inputFeePpk, mint info, keysets, quotes and every spend go through the money plane's
    // connections; the worker reaches a mint only through the host's `seller.*` handlers, and
    // main's only fetch is the loopback media proxy. A second way in would need cashu-ts.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') await walk(p);
        } else if (/\.(ts|mts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    await walk(src);
    const hits: string[] = [];
    const typeOnly: string[] = [];
    for (const f of files) {
      const r = mintReach(f, await readFile(f, 'utf8'));
      if (r.reaches.length > 0) hits.push(relative(src, f));
      else if (r.typeRefs > 0) typeOnly.push(relative(src, f));
    }
    expect(hits).toEqual(['host/money.ts']);
    const money = await readFile(join(src, 'host', 'money.ts'), 'utf8');
    // money.ts: ONE construction, and the class is not otherwise used as a value (no alias).
    const inMoney = mintReach('money.ts', money);
    expect(inMoney.reaches).toEqual(['new CashuMintConnections']);
    expect(money.match(/CashuMintConnections\(/g)).toHaveLength(1);
    expect(money).toMatch(
      /new walletMod\.CashuMintConnections\(\{\s*request: \(mint\) => o\.mintRequest\?\.\(mint\) \?\? single,/,
    );
    // Integration fix 2: recovery/core.ts names the class in a type only (so tsc checks the seed
    // option's key) — seen, and not a way to a mint.
    expect(typeOnly).toContain('host/recovery/core.ts');
  });

  it('the pin tells a way to reach a mint from a mention of one (integration fix 2)', () => {
    const reach = (text: string): readonly string[] => mintReach('x.ts', text).reaches;
    // Ways to a mint: cashu-ts in any form (a type-only import too, as the pin always had it), a
    // construction, and the class as a value (an alias, a subclass, a construct call).
    for (const text of [
      "import { Mint } from '@cashu/cashu-ts';",
      "import type { Proof } from '@cashu/cashu-ts';",
      "export * from '@cashu/cashu-ts';",
      "import cashu = require('@cashu/cashu-ts');",
      "const m = await import('@cashu/cashu-ts');",
      "const m = require('@cashu/cashu-ts');",
      "type P = import('@cashu/cashu-ts').Proof;",
      'new walletMod.CashuMintConnections({ request });',
      'new CashuMintConnections();',
      'new Mint(url, { customRequest });',
      'const C = walletMod.CashuMintConnections; new C();',
      'const { CashuMintConnections: C } = walletMod;',
      "const C = walletMod['CashuMintConnections'];",
      "const M = cashu['Mint'];",
      'class Mine extends walletMod.CashuMintConnections {}',
      'Reflect.construct(walletMod.CashuMintConnections, [{}]);',
      "import { CashuMintConnections } from '@sovit/core';",
      'export { CashuMintConnections };',
    ])
      expect(reach(text), text).not.toEqual([]);
    // Mentions only: comments, strings, and the class in a type.
    for (const text of [
      '// new walletMod.CashuMintConnections({ request, seed }) — and new Mint(',
      "/** CashuMintConnections(…), from '@cashu/cashu-ts' */ const x = 1;",
      "const s = 'from \\'@cashu/cashu-ts\\' new Mint( CashuMintConnections(';",
      'type O = ConstructorParameters<typeof walletMod.CashuMintConnections>[0];',
      'let c: walletMod.CashuMintConnections | undefined;',
      'class F implements walletMod.CashuMintConnections {}',
      'interface I extends walletMod.CashuMintConnections {}',
      "import type { CashuMintConnections } from '@sovit/core';",
      "import { type CashuMintConnections } from '@sovit/core';",
      'export type { CashuMintConnections };',
      'export { type CashuMintConnections };',
    ])
      expect(reach(text), text).toEqual([]);
  });
});

const CASHU_TS = '@cashu/cashu-ts';
const MINT_CLASSES: ReadonlySet<string> = new Set(['Mint', 'CashuMintConnections']);

/**
 * Where a source file could reach a mint (the pin above): `@cashu/cashu-ts` imported in any form
 * (statically — `import type` too —, re-exported, `require`d or `import()`ed, or named in an
 * `import()` type), `new Mint(…)` / `new …CashuMintConnections(…)`, or `CashuMintConnections` used
 * as a VALUE anywhere else (an alias, a destructuring, `obj['…']`, a subclass, an export — each
 * a way to construct one later). A reference in a TYPE (`typeof walletMod.CashuMintConnections`
 * inside `ConstructorParameters<…>`, a field's type, `implements`), a comment and a string are
 * not: integration fix 2 — `recovery/core.ts` names the class in a type so tsc checks the seed
 * option's key, and its comment spells the constructor call; neither constructs anything. Parsed
 * with the TypeScript compiler (as `packaging/stage.ts` does), not matched as text.
 */
function mintReach(
  fileName: string,
  text: string,
): { readonly reaches: readonly string[]; readonly typeRefs: number } {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const reaches: string[] = [];
  let typeRefs = 0;
  const isCashu = (n: ts.Node | undefined): boolean =>
    n !== undefined && ts.isStringLiteralLike(n) && n.text === CASHU_TS;
  /** The parent node (the source file's is `undefined`, whatever the declared type says). */
  const parentOf = (x: ts.Node): ts.Node | undefined => x.parent;
  /** A class's `extends` constructs the base class; every other heritage clause is a type. */
  const inType = (n: ts.Node): boolean => {
    for (let p = parentOf(n); p !== undefined; p = parentOf(p)) {
      if (ts.isHeritageClause(p))
        return !(p.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(p.parent));
      if (ts.isImportSpecifier(p))
        return p.isTypeOnly || p.parent.parent.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (ts.isExportSpecifier(p)) return p.isTypeOnly || p.parent.parent.isTypeOnly;
      if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
      if (ts.isStatement(p)) return false;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      isCashu(n.moduleSpecifier ?? undefined)
    )
      reaches.push(`import ${CASHU_TS}`);
    else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      isCashu(n.moduleReference.expression)
    )
      reaches.push(`import ${CASHU_TS}`);
    else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      isCashu(n.arguments[0])
    )
      reaches.push(`import ${CASHU_TS}`);
    else if (
      ts.isImportTypeNode(n) &&
      isCashu(ts.isLiteralTypeNode(n.argument) ? n.argument.literal : undefined)
    )
      reaches.push(`import ${CASHU_TS}`);
    else if (ts.isNewExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined && MINT_CLASSES.has(name)) {
        reaches.push(`new ${name}`);
        // Its callee is this construction, not another use of the class.
        ts.forEachChild(n, (c) => {
          if (c !== callee) visit(c);
        });
        return;
      }
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      MINT_CLASSES.has(n.argumentExpression.text)
    )
      reaches.push(`[${n.argumentExpression.text}]`);
    else if (ts.isIdentifier(n) && n.text === 'CashuMintConnections') {
      if (inType(n)) typeRefs++;
      else reaches.push('CashuMintConnections as a value');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { reaches, typeRefs };
}

/** A request the slow mint holds: `METHOD /path`, and how to answer it. */
interface Held {
  readonly path: string;
  answer(status: number, body: unknown): void;
}

/**
 * A local mint that holds every request until the test answers it (a slow Lightning backend: the
 * mint pays the invoice before it answers `POST /v1/melt/bolt11`). `next()` resolves when the next
 * request has fully arrived.
 */
async function slowMint(): Promise<{ url: string; next: () => Promise<Held> }> {
  const arrived: Held[] = [];
  const waiting: ((h: Held) => void)[] = [];
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const h: Held = {
        path: `${(req.method ?? 'GET').toUpperCase()} ${req.url ?? '/'}`,
        answer: (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        },
      };
      const w = waiting.shift();
      if (w === undefined) arrived.push(h);
      else w(h);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => {
          r();
        });
      }),
  );
  return {
    url: `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`,
    next: () => {
      const h = arrived.shift();
      return h === undefined ? new Promise<Held>((r) => waiting.push(r)) : Promise.resolve(h);
    },
  };
}

/** A request's outcome, observed from the start (no unhandled rejection while time is moved). */
function observe(p: Promise<unknown>): {
  readonly done: boolean;
  readonly result: Promise<unknown>;
} {
  const st = { done: false };
  const result = p.then(
    (v) => {
      st.done = true;
      return { ok: v };
    },
    (e: unknown) => {
      st.done = true;
      return { err: e };
    },
  );
  return {
    get done() {
      return st.done;
    },
    result,
  };
}

describe('fix round 3: a melt waits for its Lightning payment; every other mint request keeps 30 s', () => {
  it('hostMintRequest: a melt answered after 45 s succeeds (the mint paid the invoice); one with no answer gives up at 300 s', async () => {
    const m = await slowMint();
    const request = hostMintRequest();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const melt = observe(
        request({
          endpoint: `${m.url}/v1/melt/bolt11`,
          method: 'POST',
          requestBody: { quote: 'q1', inputs: [] },
        }),
      );
      const held = await m.next();
      expect(held.path).toBe('POST /v1/melt/bolt11');
      await vi.advanceTimersByTimeAsync(45_000);
      expect(melt.done).toBe(false); // still waiting for the payment, not cut off at 30 s
      held.answer(200, { quote: 'q1', state: 'PAID', payment_preimage: null, change: [] });
      expect(await melt.result).toEqual({
        ok: { quote: 'q1', state: 'PAID', payment_preimage: null, change: [] },
      });

      // Bounded all the same: a melt whose answer never comes is a NetworkError at 300 s.
      const stuck = observe(
        request({
          endpoint: `${m.url}/v1/melt/bolt11`,
          method: 'POST',
          requestBody: { quote: 'q2', inputs: [] },
        }),
      );
      await m.next();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(stuck.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await stuck.result).toMatchObject({
        err: { name: 'NetworkError', message: 'timed out after 300000 ms' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hostMintRequest: a mint quote, a melt quote, a swap and a quote check still time out at 30 s', async () => {
    const m = await slowMint();
    const request = hostMintRequest();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const [method, path] of [
        ['POST', '/v1/mint/quote/bolt11'],
        ['POST', '/v1/melt/quote/bolt11'],
        ['POST', '/v1/swap'],
        ['GET', '/v1/melt/quote/bolt11/q1'],
      ] as const) {
        const r = observe(
          request({
            endpoint: `${m.url}${path}`,
            method,
            ...(method === 'POST' ? { requestBody: { amount: 21, unit: 'sat' } } : {}),
          }),
        );
        expect((await m.next()).path).toBe(`${method} ${path}`);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(r.done, path).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await r.result, path).toMatchObject({
          err: { name: 'NetworkError', message: 'timed out after 30000 ms' },
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('hostMintRequest: its timeouts are the shared deadlines the worker’s pay.build is weighed against (ipc/deadlines.ts)', async () => {
    const m = await slowMint();
    const request = hostMintRequest();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const [path, ms] of [
        ['/v1/melt/bolt11', MELT_REQUEST_TIMEOUT_MS],
        ['/v1/swap', MINT_REQUEST_TIMEOUT_MS],
      ] as const) {
        const r = observe(
          request({ endpoint: `${m.url}${path}`, method: 'POST', requestBody: { quote: 'q' } }),
        );
        await m.next();
        await vi.advanceTimersByTimeAsync(ms - 1);
        expect(r.done, path).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await r.result, path).toMatchObject({
          err: { name: 'NetworkError', message: `timed out after ${String(ms)} ms` },
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
