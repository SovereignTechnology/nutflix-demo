/**
 * Lane P2-owed-viewer (ADR 0018 amendment): the host's tail authorisations on disk and in the
 * money plane.
 *
 *   - `TailBook`: one private file per identity; entries survive a re-open; expired ones pay
 *     nothing (and say so); malformed, expired and oversized content is dropped; a file that is not
 *     a private regular file is refused (an empty book), never read;
 *   - `MoneyPlane`: a session closing with blocks unpaid leaves a tail of at most what it had left
 *     (what the worker reported; its whole remaining budget when the worker could not say; nothing
 *     for 0); `pay.build` for that session's id is then checked exactly like an open session's —
 *     core, blob range, manifest terms, budget — and its blocks leave the budget on disk BEFORE the
 *     PAY is built; an expired tail is refused `forbidden`; a plane closed with sessions open keeps
 *     their tails; a re-opened plane reads them back.
 */
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
  UnixSeconds,
} from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane, sessionBudgetBlocks } from '../money.js';
import { MAX_TAILS, MAX_TAIL_BLOCKS, TAIL_TTL_MS, TailBook } from '../tails.js';

const MINT = 'https://mint.tails.test' as MintUrl;
const RELAY = 'wss://relay.tails.test' as RelayUrl;
const CORE = 'c0'.repeat(32) as CoreKeyHex;
const OTHER_CORE = 'c9'.repeat(32) as CoreKeyHex;
const SID = 'ab'.repeat(16) as SessionId;
const SID2 = 'cd'.repeat(16) as SessionId;
const PK = 'e1'.repeat(32) as NostrPubkey;
const BLOB: HyperblobId = { blockOffset: 10, blockLength: 4, byteOffset: 0, byteLength: 4096 };
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x31))).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const SEEDER_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x32))).toString(
  'hex',
) as CashuP2pkPubkey;
const SEEDER = 'd1'.repeat(32) as NostrPubkey;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: 1024,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'nf-tails-'));
  dirs.push(d);
  return d;
}

const tail = (over: Partial<Parameters<TailBook['add']>[0]> = {}) => ({
  sid: SID,
  core: CORE,
  first: 10,
  last: 13,
  policy: POLICY,
  budgetBlocks: 3,
  ...over,
});

describe('TailBook: tail authorisations on disk, per identity', () => {
  it('survive a re-open; an expired one pays nothing and says so', async () => {
    const dir = await tmp();
    let now = 1_000_000;
    const log = memoryLogger('warn');
    const a = await TailBook.open({ dir, pubkey: PK, log, now: () => now });
    await a.add(tail());
    const b = await TailBook.open({ dir, pubkey: PK, log, now: () => now });
    expect(b.get(SID)).toMatchObject({ core: CORE, budgetBlocks: 3, paidBlocks: 0 });
    expect(b.get(SID)?.expiresAt).toBe(1_000_000 + TAIL_TTL_MS);
    // Its file is private, per identity.
    const text = await readFile(join(dir, `${PK}.json`), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ v: 1 });
    now += TAIL_TTL_MS;
    expect(b.lookup(SID)).toBe('expired');
    expect(b.lookup(SID)).toBeUndefined();
    await b.flush();
    const c = await TailBook.open({ dir, pubkey: PK, log, now: () => now });
    expect(c.size()).toBe(0);
    // Another identity reads none of it.
    const d = await TailBook.open({ dir, pubkey: 'e2'.repeat(32) as NostrPubkey, log });
    expect(d.size()).toBe(0);
  });

  it('drops malformed, expired and future-dated entries on load; a damaged file is an empty book', async () => {
    const dir = await tmp();
    const now = 5_000_000;
    const good = { ...tail(), paidBlocks: 1, expiresAt: now + 1000 };
    const entries = [
      good,
      { ...good, sid: 'x' },
      { ...good, sid: SID2, core: 'nope' },
      { ...good, sid: 'ef'.repeat(16), last: 1, first: 5 },
      { ...good, sid: '01'.repeat(16), expiresAt: now - 1 },
      { ...good, sid: '02'.repeat(16), expiresAt: now + 2 * TAIL_TTL_MS },
      { ...good, sid: '03'.repeat(16), budgetBlocks: 0 },
      { ...good, sid: '04'.repeat(16), extra: true },
    ];
    await writeFile(join(dir, `${PK}.json`), JSON.stringify({ v: 1, tails: entries }), {
      mode: 0o600,
    });
    const log = memoryLogger('warn');
    const b = await TailBook.open({ dir, pubkey: PK, log, now: () => now });
    expect(b.size()).toBe(1);
    expect(b.get(SID)).toMatchObject({ paidBlocks: 1 });
    expect(log.lines.some((l) => l['dropped'] !== undefined)).toBe(true);
    await writeFile(join(dir, `${PK}.json`), '{not json', { mode: 0o600 });
    expect((await TailBook.open({ dir, pubkey: PK, log })).size()).toBe(0);
    await writeFile(join(dir, `${PK}.json`), JSON.stringify({ v: 2, tails: [good] }), {
      mode: 0o600,
    });
    expect((await TailBook.open({ dir, pubkey: PK, log })).size()).toBe(0);
  });

  it('refuses a file that is not private (readable by others, a symlink): an empty book, and it is replaced on the next write', async () => {
    if (process.platform === 'win32') return;
    const dir = await tmp();
    const now = 5_000_000;
    const good = { ...tail(), paidBlocks: 0, expiresAt: now + 1000 };
    const file = join(dir, `${PK}.json`);
    await writeFile(file, JSON.stringify({ v: 1, tails: [good] }), { mode: 0o644 });
    await chmod(file, 0o644);
    const log = memoryLogger('warn');
    expect((await TailBook.open({ dir, pubkey: PK, log, now: () => now })).size()).toBe(0);
    await rm(file);
    const elsewhere = join(await tmp(), 'target.json');
    await writeFile(elsewhere, JSON.stringify({ v: 1, tails: [good] }), { mode: 0o600 });
    await symlink(elsewhere, file);
    const b = await TailBook.open({ dir, pubkey: PK, log, now: () => now });
    expect(b.size()).toBe(0);
    await b.add(tail({ sid: SID2 }));
    // The link was replaced by a regular file; its target was never written.
    expect(JSON.parse(await readFile(elsewhere, 'utf8'))).toMatchObject({ tails: [{ sid: SID }] });
  });

  // Fix round 7 (lane P2-owed-viewer): one book owns the identity's file at a time. Once its plane
  // closed, the next plane's book reads and writes the file; a later write from the closed one
  // would put back what it held, erasing what the next one saved since.
  it('a closed book: writes started before the close land (flush waits for them); later ones write nothing and reject', async () => {
    const dir = await tmp();
    const log = memoryLogger('warn');
    const file = join(dir, `${PK}.json`);
    const a = await TailBook.open({ dir, pubkey: PK, log });
    await a.add(tail());
    const started = a.add(tail({ sid: SID2 }));
    a.close();
    await started;
    await a.flush();
    const sids = async () =>
      (JSON.parse(await readFile(file, 'utf8')) as { tails: { sid: string }[] }).tails
        .map((t) => t.sid)
        .sort();
    expect(await sids()).toEqual([SID, SID2].sort());
    // The next book owns the file now: it saves a tail of its own.
    const b = await TailBook.open({ dir, pubkey: PK, log });
    const s3 = 'ef'.repeat(16) as SessionId;
    await b.add(tail({ sid: s3 }));
    // The closed book's later writes are refused; the file keeps the next book's content.
    const late = a.get(SID)!;
    late.paidBlocks = 0;
    await expect(a.save()).rejects.toThrow(/closed/);
    await expect(a.add(tail({ sid: '12'.repeat(16) as SessionId }))).rejects.toThrow(/closed/);
    expect(a.get('12'.repeat(16))).toBeUndefined();
    await a.flush();
    expect(await sids()).toEqual([SID, SID2, s3].sort());
    // A memory-only book is fenced alike.
    const m = await TailBook.open({ dir: null, pubkey: PK, log });
    m.close();
    await expect(m.save()).rejects.toThrow(/closed/);
  });

  it('keeps at most MAX_TAILS, the ones expiring first going; refuses an empty budget or a bad sid', async () => {
    let now = 0;
    const b = await TailBook.open({
      dir: null,
      pubkey: PK,
      log: memoryLogger('warn'),
      now: () => now,
    });
    for (let i = 0; i < MAX_TAILS + 3; i++) {
      now = i;
      await b.add(tail({ sid: i.toString(16).padStart(32, '0') as SessionId }));
    }
    expect(b.size()).toBe(MAX_TAILS);
    expect(b.get('0'.repeat(32))).toBeUndefined();
    expect(b.get((MAX_TAILS + 2).toString(16).padStart(32, '0'))).toBeDefined();
    await b.add(tail({ sid: SID, budgetBlocks: 0 }));
    await b.add(tail({ sid: 'nope' as SessionId }));
    expect(b.get(SID)).toBeUndefined();
  });
});

type RequestFn = mocks.TestMint['request'];

async function planeRig(
  o: {
    dir?: string | null;
    skew?: { ms: number };
    fund?: number;
    /** Wraps the mint's transport (holding a request). */
    wrap?: (inner: RequestFn) => RequestFn;
  } = {},
) {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x62) });
  const request = o.wrap?.(mint.request) ?? mint.request;
  const pool = new nostr.FakeRelayPool();
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('tails test passphrase'),
    cost: signerMod.minimumCost(),
  });
  let t = 1_757_000_000;
  const skew = o.skew ?? { ms: 0 };
  const open = (create: boolean) =>
    MoneyPlane.open({
      signer,
      journalDir: null,
      tailDir: o.dir ?? null,
      tailClock: () => Date.now() + skew.ms,
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => request,
      now: () => t++ as UnixSeconds,
      ...(create ? { createWallet: true } : {}),
    });
  const plane = await open(true);
  if ((o.fund ?? 0) > 0) {
    const q = await plane.wallet.mintQuote(MINT, o.fund as Sats);
    mint.payQuote(q.quoteId);
    await plane.wallet.pollQuote(q);
  }
  return { plane, open, skew };
}

const build = (
  over: {
    sid?: SessionId;
    range?: { core: CoreKeyHex; fromBlock: number; toBlock: number };
    policy?: PricePolicy;
  } = {},
) => ({
  sid: over.sid ?? SID,
  range: over.range ?? { core: CORE, fromBlock: 10, toBlock: 11 },
  seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: MINT },
  policy: over.policy ?? POLICY,
  carryIn: 0,
});
const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => String((e as { code?: unknown }).code),
  );

describe('MoneyPlane: tail authorisations (ADR 0018 amendment)', () => {
  it('a session closed with blocks unpaid leaves a tail: pay.build for its id is checked like an open session — core, blob, terms, budget', async () => {
    const { plane } = await planeRig({ fund: 200 });
    const h = plane.handlers();
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 3);
    const refused = (b: ReturnType<typeof build>) => code(h['pay.build']!(b));
    expect(await refused(build({ range: { core: OTHER_CORE, fromBlock: 10, toBlock: 10 } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ range: { core: CORE, fromBlock: 9, toBlock: 10 } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ range: { core: CORE, fromBlock: 13, toBlock: 14 } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ policy: { ...POLICY, satsPerBlock: 3 as Sats } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ policy: { ...POLICY, creatorP2pk: SEEDER_P2PK } }))).toBe(
      'forbidden',
    );
    // Within its terms: paid, off the budget (3 blocks).
    const msg = await h['pay.build']!(build());
    expect(msg.range).toEqual({ core: CORE, fromBlock: 10, toBlock: 11 });
    expect(await refused(build({ range: { core: CORE, fromBlock: 12, toBlock: 13 } }))).toBe(
      'forbidden',
    ); // 2 more would pass its budget of 3
    expect(
      await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 12, toBlock: 12 } }))),
    ).toBe('resolved');
    // Never another session's: an unknown id is closed.
    expect(await refused(build({ sid: SID2 }))).toBe('session-closed');
  });

  it('its budget: what the worker reported, at most what the session had left; null = all it had left; 0 = no tail', async () => {
    const { plane } = await planeRig({ fund: 400 });
    const h = plane.handlers();
    const whole = sessionBudgetBlocks(BLOB);
    // Paid 2 while open: 2 × 4 + 4 − 2 left.
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await h['pay.build']!(build());
    await plane.revokeSession(SID, 10_000);
    let paid = 0;
    for (;;) {
      const r = await code(
        h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } })),
      );
      if (r !== 'resolved') {
        expect(r).toBe('forbidden');
        break;
      }
      paid++;
    }
    expect(paid).toBe(whole - 2);
    // Unknown (the worker gone): all it had left.
    plane.authorizeSession(SID2, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID2, null);
    expect(await code(h['pay.build']!(build({ sid: SID2 })))).toBe('resolved');
    // Nothing unpaid: no tail — the session is simply closed.
    const s3 = 'ef'.repeat(16) as SessionId;
    plane.authorizeSession(s3, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(s3, 0);
    expect(await code(h['pay.build']!(build({ sid: s3 })))).toBe('session-closed');
    const s4 = '12'.repeat(16) as SessionId;
    plane.authorizeSession(s4, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(s4); // the default: a close that left nothing
    expect(await code(h['pay.build']!(build({ sid: s4 })))).toBe('session-closed');
  }, 30_000); // a dozen real P2PK sends at the in-process mint, one per block: slower than 5 s under load

  it('persisted: a re-opened plane pays a tail; its blocks leave the budget on disk BEFORE the PAY is built; an expired one is refused forbidden', async () => {
    const dir = await tmp();
    const { plane, open, skew } = await planeRig({ dir, fund: 200 });
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 2);
    plane.close();
    const again = await open(false);
    const h = again.handlers();
    // The file says what is left before the wallet is asked: a write that fails refuses the PAY.
    const file = join(dir, `${again.pubkey}.json`);
    await chmod(dir, 0o500);
    try {
      if (process.getuid?.() !== 0)
        expect(
          await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } }))),
        ).toBe('internal');
    } finally {
      await chmod(dir, 0o700);
    }
    expect(
      await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } }))),
    ).toBe('resolved');
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as {
      tails: { sid: string; paidBlocks: number }[];
    };
    expect(onDisk.tails.find((t) => t.sid === SID)?.paidBlocks).toBe(1);
    skew.ms = TAIL_TTL_MS + 1;
    expect(
      await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 11, toBlock: 11 } }))),
    ).toBe('forbidden');
    again.close();
  });

  // Review finding (lane P2-owed-viewer, LOW): a closed session kept its whole remaining budget
  // (up to twice its blob) as a tail for 7 days, on the worker's word or its silence.
  it('a tail is never more than MAX_TAIL_BLOCKS, whatever the worker claims or when it cannot say', async () => {
    const dir = await tmp();
    const { plane } = await planeRig({ dir });
    const big: HyperblobId = { blockOffset: 0, blockLength: 5000, byteOffset: 0, byteLength: 1 };
    plane.authorizeSession(SID, { core: CORE, blob: big, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 1_000_000);
    plane.authorizeSession(SID2, { core: CORE, blob: big, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID2, null);
    const onDisk = JSON.parse(await readFile(join(dir, `${plane.pubkey}.json`), 'utf8')) as {
      tails: { sid: string; budgetBlocks: number }[];
    };
    expect(onDisk.tails.map((t) => t.budgetBlocks)).toEqual([MAX_TAIL_BLOCKS, MAX_TAIL_BLOCKS]);
    expect(sessionBudgetBlocks(big)).toBeGreaterThan(MAX_TAIL_BLOCKS);
    // A file claiming more is refused entry by entry.
    await writeFile(
      join(dir, `${plane.pubkey}.json`),
      JSON.stringify({
        v: 1,
        tails: [{ ...onDisk.tails[0], budgetBlocks: MAX_TAIL_BLOCKS + 1 }],
      }),
      { mode: 0o600 },
    );
    const b = await TailBook.open({ dir, pubkey: plane.pubkey, log: memoryLogger('warn') });
    expect(b.size()).toBe(0);
    plane.close();
  });

  // Independent review (lane P2-owed-viewer, info): the tail is looked up again when the PAY's turn
  // at the mint comes (PAYs take turns there); replacing that re-check with the tail found at
  // arrival left every test green. A tail that expires while its PAY waits must spend nothing.
  it('a tail that expires while its PAY waits for its turn at the mint: refused session-closed, nothing spent', async () => {
    const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const wrap =
      (inner: RequestFn): RequestFn =>
      <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
        if (!gate.hold || path !== 'POST /v1/swap') return inner<T>(args);
        gate.hold = false;
        return new Promise<T>((resolve, reject) => {
          gate.release = () => {
            inner<T>(args).then(resolve, reject);
          };
        });
      };
    const { plane, skew } = await planeRig({ fund: 200, wrap });
    const h = plane.handlers();
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 2); // a tail of 2 blocks
    plane.authorizeSession(SID2, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const before = await plane.wallet.balance(MINT);
    // An open session's PAY holds the mint's turn (its swap held at the mint)…
    gate.hold = true;
    const first = h['pay.build']!(build({ sid: SID2 }));
    for (let i = 0; i < 500 && gate.release === null; i++)
      await new Promise((r) => setTimeout(r, 2));
    const release = gate.release;
    if (release === null) throw new Error('the first PAY never reached the mint');
    // …the tail's PAY is authorised on arrival and waits for its turn; meanwhile the tail expires.
    const second = code(
      h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } })),
    );
    await new Promise((r) => setTimeout(r, 30));
    skew.ms = TAIL_TTL_MS + 1;
    release();
    await expect(first).resolves.toMatchObject({ range: { fromBlock: 10, toBlock: 11 } });
    expect(await second).toBe('session-closed');
    expect(before - (await plane.wallet.balance(MINT))).toBe(2 * POLICY.satsPerBlock);
    plane.close();
  }, 30_000);

  // Fix round 7 (lane P2-owed-viewer, the verifier's residual of finding 5): a tail's PAY waiting
  // for its turn at the mint when the plane closed (signed out, locked) was refused at its turn and
  // gave its blocks back by saving the CLOSED plane's book — after the next plane had read the file
  // and saved a tail of its own, which that late write erased from disk. The closed plane's book is
  // fenced at the close: what it would have given back stays taken (respected, never paid).
  it('a tail PAY still waiting at the mint when the plane closes: at its turn it writes nothing over the next plane’s tails', async () => {
    const dir = await tmp();
    const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const wrap =
      (inner: RequestFn): RequestFn =>
      <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
        if (!gate.hold || path !== 'POST /v1/swap') return inner<T>(args);
        gate.hold = false;
        return new Promise<T>((resolve, reject) => {
          gate.release = () => {
            inner<T>(args).then(resolve, reject);
          };
        });
      };
    const { plane, open } = await planeRig({ dir, fund: 200, wrap });
    const file = join(dir, `${plane.pubkey}.json`);
    const onDisk = async () =>
      (JSON.parse(await readFile(file, 'utf8')) as { tails: { sid: string; paidBlocks: number }[] })
        .tails;
    const h = plane.handlers();
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 2); // a tail of 2 blocks
    plane.authorizeSession(SID2, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    // An open session's PAY holds the mint's turn (its swap held at the mint)…
    gate.hold = true;
    const first = code(h['pay.build']!(build({ sid: SID2 })));
    for (let i = 0; i < 500 && gate.release === null; i++)
      await new Promise((r) => setTimeout(r, 2));
    const release = gate.release;
    if (release === null) throw new Error('the first PAY never reached the mint');
    // …the tail's PAY takes its block off the budget on disk, then waits for its turn.
    const second = code(
      h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } })),
    );
    for (let i = 0; i < 500; i++) {
      if ((await onDisk()).find((t) => t.sid === SID)?.paidBlocks === 1) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 20));
    // Signed out (or locked), then back in at once: the next plane reads the file after the
    // closed one's writes landed, and saves a tail of its own.
    plane.close();
    await plane.flushTails();
    const next = await open(false);
    const s3 = 'ef'.repeat(16) as SessionId;
    next.authorizeSession(s3, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await next.revokeSession(s3, 2);
    expect((await onDisk()).map((t) => t.sid).sort()).toEqual([SID, SID2, s3].sort());
    // The tail PAY's turn comes: the closed plane refuses it, and writes nothing.
    release();
    expect(await second).toBe('payments-unavailable');
    await first;
    await plane.flushTails();
    await next.flushTails();
    const after = await onDisk();
    expect(after.map((t) => t.sid).sort()).toEqual([SID, SID2, s3].sort());
    // What the refused PAY would have given back stays taken: the conservative side.
    expect(after.find((t) => t.sid === SID)?.paidBlocks).toBe(1);
    // The next plane's book agrees with the file: SID has 1 block left, s3 its 2 — asked for one
    // block more than each has, both are refused on their budget (`forbidden`, not
    // `session-closed`), before the wallet. (Nothing is spent here: this rig keeps no wallet
    // journal, so the next plane's wallet still lists the proofs the closed plane's PAY swapped.)
    const h2 = next.handlers();
    expect(
      await code(h2['pay.build']!(build({ range: { core: CORE, fromBlock: 11, toBlock: 12 } }))),
    ).toBe('forbidden');
    expect(
      await code(
        h2['pay.build']!(build({ sid: s3, range: { core: CORE, fromBlock: 10, toBlock: 12 } })),
      ),
    ).toBe('forbidden');
    expect(await code(h2['pay.build']!(build({ sid: '34'.repeat(16) as SessionId })))).toBe(
      'session-closed',
    );
    next.close();
  }, 30_000);

  it('a plane closed with sessions open (signed out, locked) keeps their tails; a closed plane makes none', async () => {
    const dir = await tmp();
    const { plane, open } = await planeRig({ dir, fund: 200 });
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    plane.close();
    await plane.flushTails();
    // Revoked after the close: nothing more (the plane is closed; its tail was kept at the close).
    await plane.revokeSession(SID, 3);
    const again = await open(false);
    expect(await code(again.handlers()['pay.build']!(build()))).toBe('resolved');
    again.close();
  });
});

describe('R2: an open session’s crash tail (Cameron, 2026-10-02: persist open-session budgets)', () => {
  it('TailBook: a provisional tail never pays in the run that wrote it; a re-opened book (after a crash) makes it an ordinary tail; drop forgets it', async () => {
    const dir = await tmp();
    const log = memoryLogger('info');
    const book = await TailBook.open({ dir, pubkey: PK, log });
    await book.provisional(tail({ budgetBlocks: 5 }));
    await book.provisional(tail({ sid: SID2, budgetBlocks: 5 }));
    expect(book.get(SID)).toBeUndefined();
    expect(book.lookup(SID)).toBeUndefined();
    await book.drop(SID2);
    // Lowered to nothing: dropped too.
    const s3 = 'ef'.repeat(16) as SessionId;
    await book.provisional(tail({ sid: s3, budgetBlocks: 4 }));
    await book.provisional(tail({ sid: s3, budgetBlocks: 0 }));
    // The app crashed: a new run reads the file.
    const again = await TailBook.open({ dir, pubkey: PK, log });
    expect(again.get(SID)).toMatchObject({ budgetBlocks: 5, paidBlocks: 0 });
    expect(again.get(SID)?.provisional).toBeUndefined();
    expect(again.get(SID2)).toBeUndefined();
    expect(again.get(s3)).toBeUndefined();
    expect(log.lines.map((l) => l.msg)).toContain('play sessions open at a crash keep their tails');
  });

  it('a full-app crash with a session open: the next run pays its tail — what it had left, each PAY of the open session having lowered it on disk BEFORE it was built', async () => {
    const dir = await tmp();
    const { plane, open } = await planeRig({ dir, fund: 400 });
    const h = plane.handlers();
    const whole = sessionBudgetBlocks(BLOB);
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.flushTails();
    const file = join(dir, `${plane.pubkey}.json`);
    const onDisk = async (): Promise<number | undefined> =>
      (
        JSON.parse(await readFile(file, 'utf8')) as {
          tails: { sid: string; budgetBlocks: number; provisional?: boolean }[];
        }
      ).tails.find((t) => t.sid === SID && t.provisional === true)?.budgetBlocks;
    expect(await onDisk()).toBe(whole);
    expect(await code(h['pay.build']!(build()))).toBe('resolved'); // 2 blocks, open session
    expect(await onDisk()).toBe(whole - 2);
    // The whole app dies here: the plane is never closed, the session never revoked.
    const after = await open(false);
    const h2 = after.handlers();
    let paid = 0;
    for (;;) {
      const r = await code(
        h2['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } })),
      );
      if (r !== 'resolved') {
        expect(r).toBe('forbidden');
        break;
      }
      paid++;
    }
    expect(paid).toBe(whole - 2);
    after.close();
  }, 30_000);

  it('a session closed with nothing unpaid leaves no crash tail: a crash after it pays nothing for it', async () => {
    const dir = await tmp();
    const { plane, open } = await planeRig({ dir, fund: 200 });
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.revokeSession(SID, 0);
    await plane.flushTails();
    const after = await open(false);
    expect(await code(after.handlers()['pay.build']!(build()))).toBe('session-closed');
    after.close();
  });

  it('a PAY of the open session that fails after the session closed gives nothing back to a crash tail: the closed session’s ordinary tail stays payable', async () => {
    const dir = await tmp();
    const gate: { hold: boolean; fail: (() => void) | null } = { hold: false, fail: null };
    const wrap =
      (inner: RequestFn): RequestFn =>
      <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
        if (!gate.hold || path !== 'POST /v1/swap') return inner<T>(args);
        gate.hold = false;
        return new Promise<T>((_resolve, reject) => {
          gate.fail = () => {
            reject(new Error('the mint went away'));
          };
        });
      };
    const { plane } = await planeRig({ dir, fund: 200, wrap });
    const h = plane.handlers();
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    gate.hold = true;
    const first = code(h['pay.build']!(build()));
    for (let i = 0; i < 500 && gate.fail === null; i++) await new Promise((r) => setTimeout(r, 2));
    if (gate.fail === null) throw new Error('the PAY never reached the mint');
    // The session closes while its PAY is at the mint: an ordinary tail of 3 blocks.
    await plane.revokeSession(SID, 3);
    gate.fail();
    expect(await first).not.toBe('resolved');
    await plane.flushTails();
    // Its ordinary tail is still a tail (not turned back into a provisional one): it pays.
    expect(
      await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 10 } }))),
    ).toBe('resolved');
    plane.close();
  }, 30_000);

  it('a crash tail that cannot be lowered on disk refuses the open session’s PAY: nothing spent', async () => {
    const dir = await tmp();
    const { plane } = await planeRig({ dir, fund: 200 });
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await plane.flushTails();
    const before = await plane.wallet.balance(MINT);
    // The directory is gone and a file sits in its place: every write fails (even as root).
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'not a directory');
    try {
      expect(await code(plane.handlers()['pay.build']!(build()))).toBe('internal');
      expect(await plane.wallet.balance(MINT)).toBe(before);
    } finally {
      await rm(dir, { force: true });
    }
    plane.close();
  });
});
