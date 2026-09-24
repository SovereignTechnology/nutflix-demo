/**
 * The daemon runtime's parts, one at a time (`runtime/`): the wallet's proof file, the pending
 * PAY and seen-secret files, the keyset rate limit, the identity unlock (key file + systemd
 * credential), the NIP-61 nutzap and kind 10019 events, and the one-daemon-per-data-dir lock.
 * The composition over a real swarm is `seeder-runtime.integration.test.ts`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NostrKind, nostr, signer as signerMod } from '@sovit/core';
import type {
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  LockedProofSet,
  MintKeyset,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  RelayUrl,
  Sats,
} from '@sovit/core';
import { verifyEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';

import { validateDaemonConfig } from '../cli/config-file.js';
import type { DaemonConfig } from '../cli/config-file.js';
import {
  JOURNAL_COMPACT_FACTOR,
  PendingJournal,
  SeenLog,
  loadPending,
  pendingWriter,
  readPendingJournal,
} from '../runtime/engine-state.js';
import { RuntimeSetupError } from '../runtime/files.js';
import {
  PASSPHRASE_CREDENTIAL,
  createKeyFile,
  readPassphrase,
  unlockIdentity,
} from '../runtime/identity.js';
import { createSeederRuntime } from '../runtime/index.js';
import { guardedKeyset } from '../runtime/keysets.js';
import { nodeRawHttp } from '../runtime/mint-http.js';
import { announceNutzapInfo, nutzapPublisher } from '../runtime/nostr-publish.js';
import { FileProofStore, HISTORY_LIMIT, selfCipher } from '../runtime/proof-file.js';
import type { FileCipher } from '../runtime/proof-file.js';
import { capturedLogger, tmpDir } from './helpers.js';

const MINT = 'https://mint.runtime.example' as MintUrl;
const RELAY = 'wss://relay.runtime.example' as RelayUrl;
const CREATOR_P2PK = `02${'c7'.repeat(32)}` as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const PASS = 'runtime-unit-passphrase-0123456789';
const COST = signerMod.minimumCost();

/** The wallet file's cipher: NIP-44 to a test node's own key, as the runtime seals it. */
const NODE = (await signerMod.LocalSigner.create({ passphrase: Buffer.from(PASS), cost: COST }))
  .signer;
const CIPHER: FileCipher = selfCipher(NODE, await NODE.getPublicKey());

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratch(): Promise<string> {
  const t = await tmpDir('nutflix-runtime-');
  cleanups.push(t.rm);
  return t.dir;
}

function proof(n: number, amount = 2): CashuProof {
  return {
    id: '00ab'.repeat(4),
    amount,
    secret: `secret-${String(n)}`,
    C: `02${n.toString(16).padStart(64, '0')}`,
  };
}

// ------------------------------------------------------------------------ FileProofStore

describe('FileProofStore (the wallet file)', () => {
  it('starts empty, commits durably (0600), and a reopen sees exactly the committed state', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const a = await FileProofStore.open(file, CIPHER);
    expect(await a.mints()).toEqual([]);
    const e1 = await a.commit({
      mint: MINT,
      spent: [],
      added: [proof(1), proof(2), proof(3)],
      history: { direction: 'in', amount: 6 as Sats, memo: 'swap' },
    });
    expect(e1).toMatchObject({ direction: 'in', amount: 6, mint: MINT, memo: 'swap' });
    await a.commit({ mint: MINT, spent: [proof(2)], added: [proof(4, 8)] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const b = await FileProofStore.open(file, CIPHER);
    expect((await b.proofs(MINT)).map((p) => p.secret).sort()).toEqual([
      'secret-1',
      'secret-3',
      'secret-4',
    ]);
    expect(await b.history()).toEqual([e1]);
    // Spending a mint's last proof drops the mint.
    await b.commit({ mint: MINT, spent: await b.proofs(MINT), added: [] });
    expect(await (await FileProofStore.open(file, CIPHER)).mints()).toEqual([]);
  });

  it('serialises concurrent commits: none is lost', async () => {
    const dir = await scratch();
    const store = await FileProofStore.open(path.join(dir, 'proofs.json'), CIPHER);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.commit({ mint: MINT, spent: [], added: [proof(i)] }),
      ),
    );
    const again = await FileProofStore.open(path.join(dir, 'proofs.json'), CIPHER);
    expect(await again.proofs(MINT)).toHaveLength(20);
  });

  it('a leftover .tmp (a crash mid-write, or a planted symlink) is replaced, never written through', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const outside = path.join(dir, 'outside.txt');
    await writeFile(outside, 'untouched', { mode: 0o644 });
    await symlink(outside, `${file}.tmp`);
    await (
      await FileProofStore.open(file, CIPHER)
    ).commit({ mint: MINT, spent: [], added: [proof(1)] });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The synchronous writer (pending PAYs) too.
    const pending = path.join(dir, 'pending.json');
    await symlink(outside, `${pending}.tmp`);
    pendingWriter(pending, () => undefined)([]);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await stat(pending)).mode & 0o777).toBe(0o600);
  });

  it('sealed at rest: NIP-44 to the node key — no proof in clear on disk; another key, a flipped byte, a dropped or reordered chunk are all refused and the file left alone', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const store = await FileProofStore.open(file, CIPHER);
    // Enough proofs for several 60 000-character chunks.
    const many = Array.from({ length: 700 }, (_, i) => ({
      ...proof(i),
      dleq: { e: 'e'.repeat(64), s: 's'.repeat(64), r: 'f'.repeat(64) },
    }));
    await store.commit({
      mint: MINT,
      spent: [],
      added: many,
      history: { direction: 'in', amount: 1400 as Sats, memo: 'swap — é ✓' },
    });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('secret-1');
    expect(text).not.toContain(many[3]!.C);
    const env = JSON.parse(text) as { v: number; enc: string; chunks: string[] };
    expect(env).toMatchObject({ v: 2, enc: 'nip44-self' });
    expect(env.chunks.length).toBeGreaterThan(2);
    // It reopens with the node key, non-ASCII intact.
    const again = await FileProofStore.open(file, CIPHER);
    expect(await again.proofs(MINT)).toHaveLength(700);
    expect((await again.history())[0]?.memo).toBe('swap — é ✓');

    const refused = async (content: string, cipher: FileCipher = CIPHER): Promise<void> => {
      await writeFile(file, content, { mode: 0o600 });
      await expect(FileProofStore.open(file, cipher)).rejects.toThrow(/not sealed to this node/);
      expect(await readFile(file, 'utf8')).toBe(content);
    };
    const other = (
      await signerMod.LocalSigner.create({ passphrase: Buffer.from(PASS), cost: COST })
    ).signer;
    await refused(text, selfCipher(other, await other.getPublicKey()));
    const flip = [...env.chunks];
    const c0 = flip[0]!;
    flip[0] = `${c0.slice(0, 40)}${c0[40] === 'A' ? 'B' : 'A'}${c0.slice(41)}`;
    await refused(JSON.stringify({ ...env, chunks: flip }));
    await refused(JSON.stringify({ ...env, chunks: env.chunks.slice(1) }));
    await refused(
      JSON.stringify({ ...env, chunks: [env.chunks[1], env.chunks[0], ...env.chunks.slice(2)] }),
    );
    await refused(JSON.stringify({ ...env, chunks: env.chunks.slice(0, -1) }));
  });

  it('an unencrypted (version 1) wallet file is read and resealed at open', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const v1 = {
      format: 'nutflix-seeder-wallet',
      v: 1,
      seq: 0,
      mints: { [MINT]: [proof(1), proof(2)] },
      history: [],
    };
    await writeFile(file, JSON.stringify(v1), { mode: 0o600 });
    const store = await FileProofStore.open(file, CIPHER);
    expect(store.migrated).toBe(true);
    expect(await store.proofs(MINT)).toHaveLength(2);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('secret-1');
    expect(JSON.parse(text)).toMatchObject({ v: 2, enc: 'nip44-self' });
    const reopened = await FileProofStore.open(file, CIPHER);
    expect(reopened.migrated).toBe(false);
    expect(await reopened.proofs(MINT)).toHaveLength(2);
  });

  it('keeps the newest HISTORY_LIMIT history lines, newest first', async () => {
    const dir = await scratch();
    const store = await FileProofStore.open(path.join(dir, 'proofs.json'), CIPHER);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++)
      await store.commit({
        mint: MINT,
        spent: [],
        added: [],
        history: { direction: 'in', amount: i as Sats },
      });
    const h = await (await FileProofStore.open(path.join(dir, 'proofs.json'), CIPHER)).history();
    expect(h).toHaveLength(HISTORY_LIMIT);
    expect(h[0]?.amount).toBe(HISTORY_LIMIT + 4);
  }, 60_000);

  it('refuses to start on a file it cannot trust — unreadable, a foreign format, or readable by others — and never overwrites it', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    for (const junk of [
      '{',
      '[]',
      '{"format":"other","v":1}',
      JSON.stringify({
        format: 'nutflix-seeder-wallet',
        v: 1,
        seq: 0,
        mints: { [MINT]: [{ amount: -1 }] },
        history: [],
      }),
    ]) {
      await writeFile(file, junk, { mode: 0o600 });
      await expect(FileProofStore.open(file, CIPHER)).rejects.toBeInstanceOf(RuntimeSetupError);
      expect(await readFile(file, 'utf8')).toBe(junk);
    }
    const good = await scratch();
    const f2 = path.join(good, 'proofs.json');
    await (
      await FileProofStore.open(f2, CIPHER)
    ).commit({ mint: MINT, spent: [], added: [proof(1)] });
    await chmod(f2, 0o640);
    await expect(FileProofStore.open(f2, CIPHER)).rejects.toThrow(/accessible to group or others/);
  });
});

// ------------------------------------------------------------------------ pending + seen

describe('pending PAYs and seen secrets on disk', () => {
  const item = {
    peer: 'ab'.repeat(32) as NostrPubkey,
    stage: 'redeem' as const,
    redeemTried: true,
    msg: {
      range: { core: 'cd'.repeat(32) as CoreKeyHex, fromBlock: 0, toBlock: 3 },
      carryIn: 0,
      seederProofs: {
        mint: MINT,
        unit: 'sat' as const,
        lockedTo: CREATOR_P2PK,
        proofs: [proof(1)],
      },
      creatorProofs: {
        mint: MINT,
        unit: 'sat' as const,
        lockedTo: CREATOR_P2PK,
        proofs: [proof(2)],
      },
    },
  };

  it('the pending snapshot round-trips, 0600; missing = none; a damaged file stops the daemon', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'pending.json');
    expect(loadPending(file)).toEqual([]);
    const errors: unknown[] = [];
    const write = pendingWriter(file, (e) => errors.push(e));
    write([item]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(loadPending(file)).toEqual([item]);
    write([]);
    expect(loadPending(file)).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(file, '{"format":"nutflix-seeder-pending","v":1,"items":{}}', { mode: 0o600 });
    expect(() => loadPending(file)).toThrow(/refusing to start rather than drop accepted payments/);
  });

  const variant = (n: number, extra: Partial<typeof item> = {}): typeof item => ({
    ...item,
    ...extra,
    msg: {
      ...item.msg,
      range: { ...item.msg.range, fromBlock: n * 4, toBlock: n * 4 + 3 },
      seederProofs: { ...item.msg.seederProofs, proofs: [proof(100 + n)] },
      creatorProofs: { ...item.msg.creatorProofs, proofs: [proof(200 + n)] },
    },
  });
  const lineCount = async (f: string): Promise<number> =>
    (await readFile(f, 'utf8')).split('\n').filter((l) => l !== '').length;

  it('the journal APPENDS what changed (never rewrites the queue), and replays to the live set', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'pending.jsonl');
    const j = PendingJournal.open(file, path.join(dir, 'pending.json'), () => undefined);
    expect(j.items).toEqual([]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const a = variant(1);
    const b = variant(2);
    j.persist([a]);
    expect(await lineCount(file)).toBe(2); // header + add
    const before = await readFile(file, 'utf8');
    j.persist([a, b]);
    const after = await readFile(file, 'utf8');
    expect(after.startsWith(before)).toBe(true); // appended, the earlier lines untouched
    expect(await lineCount(file)).toBe(3);
    // A PAY that moves on (redeem → nutzap) is one removal and one addition.
    const aNutzap = { ...a, stage: 'nutzap' as const };
    j.persist([aNutzap, b]);
    expect(await lineCount(file)).toBe(5);
    j.persist([b]);
    j.close();
    expect(readPendingJournal(file)).toEqual([b]);
    const again = PendingJournal.open(file, path.join(dir, 'pending.json'), () => undefined);
    expect(again.items).toEqual([b]);
    // Reopening compacts: just the live PAY.
    expect(await lineCount(file)).toBe(2);
    again.close();
  });

  it('the journal compacts itself: its size stays bounded by the live queue', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'pending.jsonl');
    const j = PendingJournal.open(file, path.join(dir, 'pending.json'), () => undefined);
    let worst = 0;
    // A rolling queue of 3 over 500 changes: without compaction ~1000 lines.
    for (let i = 0; i < 500; i++) {
      j.persist([variant(i), variant(i + 1), variant(i + 2)]);
      worst = Math.max(worst, await lineCount(file));
    }
    expect(worst).toBeLessThanOrEqual(Math.max(64, JOURNAL_COMPACT_FACTOR * 3) + 1 + 2);
    j.close();
    expect(readPendingJournal(file).map((x) => x.msg.range.fromBlock)).toEqual([
      499 * 4,
      500 * 4,
      501 * 4,
    ]);
  });

  it('a torn last line is a crash mid-append; any other damage refuses to start', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'pending.jsonl');
    const j = PendingJournal.open(file, path.join(dir, 'pending.json'), () => undefined);
    j.persist([variant(1)]);
    j.close();
    const good = await readFile(file, 'utf8');
    await writeFile(file, `${good}{"a":{"peer":"ab`, { mode: 0o600 });
    expect(readPendingJournal(file)).toHaveLength(1);
    await writeFile(file, `${good}not json\n${JSON.stringify({ d: 'x' })}\n`, { mode: 0o600 });
    expect(() => readPendingJournal(file)).toThrow(/refusing to start rather than drop/);
    await writeFile(file, `${JSON.stringify({ a: variant(1) })}\n`, { mode: 0o600 }); // no header
    expect(() => readPendingJournal(file)).toThrow(RuntimeSetupError);
    await writeFile(file, `${good}${JSON.stringify({ q: 1 })}\n`, { mode: 0o600 });
    expect(() => readPendingJournal(file)).toThrow(RuntimeSetupError);
    await writeFile(file, good, { mode: 0o644 });
    await chmod(file, 0o644);
    expect(() =>
      PendingJournal.open(file, path.join(dir, 'pending.json'), () => undefined),
    ).toThrow(RuntimeSetupError);
  });

  it('an old pending.json is migrated into the journal, then removed', async () => {
    const dir = await scratch();
    const legacy = path.join(dir, 'pending.json');
    pendingWriter(legacy, () => undefined)([variant(1), variant(2)]);
    const file = path.join(dir, 'pending.jsonl');
    const j = PendingJournal.open(file, legacy, () => undefined);
    expect(j.items).toHaveLength(2);
    j.close();
    await expect(stat(legacy)).rejects.toThrow();
    expect(readPendingJournal(file)).toHaveLength(2);
  });

  it('a failed pending write is reported AND thrown (the engine swallows it, the log must not)', async () => {
    const dir = await scratch();
    const errors: unknown[] = [];
    const write = pendingWriter(path.join(dir, 'no-such-dir', 'pending.json'), (e) =>
      errors.push(e),
    );
    expect(() => {
      write([item]);
    }).toThrow();
    expect(errors).toHaveLength(1);
  });

  it('seen secrets append as JSON lines (a newline inside a secret cannot split it) and a torn line is skipped', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'seen.jsonl');
    const errors: unknown[] = [];
    const log = new SeenLog(file, 100, (e) => errors.push(e));
    expect(log.load()).toEqual([]);
    log.append(['a', 'b\nc', '["P2PK",{"data":"x"}]']);
    log.append(['d']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(new SeenLog(file, 100, () => undefined).load()).toEqual([
      'a',
      'b\nc',
      '["P2PK",{"data":"x"}]',
      'd',
    ]);
    await writeFile(file, (await readFile(file, 'utf8')) + '"torn', { flag: 'w' });
    expect(new SeenLog(file, 100, () => undefined).load()).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  it('rotates every `capacity` lines: the disk holds at most two generations, load() returns the newest `capacity`', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'seen.jsonl');
    const log = new SeenLog(file, 10, () => undefined);
    log.load();
    for (let i = 0; i < 35; i++) log.append([`s${String(i)}`]);
    const lines = async (f: string): Promise<number> =>
      (await readFile(f, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    // 35 appends at capacity 10: rotated at 10, 20, 30 → `.1` holds 20-29, the current 30-34.
    expect(await lines(`${file}.1`)).toBe(10);
    expect(await lines(file)).toBe(5);
    expect(new SeenLog(file, 10, () => undefined).load()).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${String(i + 25)}`),
    );
    // A current file already at capacity (an older daemon) is rotated at load.
    await writeFile(
      file,
      Array.from({ length: 12 }, (_, i) => `"x${String(i)}"`).join('\n') + '\n',
      {
        mode: 0o600,
      },
    );
    const again = new SeenLog(file, 10, () => undefined);
    expect(again.load()).toEqual(Array.from({ length: 10 }, (_, i) => `x${String(i + 2)}`));
    expect(await lines(file)).toBe(0);
    expect(await lines(`${file}.1`)).toBe(12);
  });

  it('a failed append is reported, never thrown (it runs inside verify)', async () => {
    const dir = await scratch();
    const errors: unknown[] = [];
    const broken = new SeenLog(path.join(dir, 'nope', 'seen.jsonl'), 10, (e) => errors.push(e));
    expect(() => {
      broken.append(['x']);
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(() => new SeenLog(path.join(dir, 's'), 0, () => undefined)).toThrow();
  });
});

// ------------------------------------------------------------------------ keyset guard

describe('guardedKeyset (the keyset hook, rate-limited)', () => {
  const ks = (id: string): MintKeyset => ({
    mint: MINT,
    id,
    unit: 'sat',
    active: true,
    keys: {},
    fetchedAt: 0,
  });

  it('a resolved id is free forever; ids not yet seen spend a per-mint token; an empty bucket answers undefined without asking', async () => {
    let t = 0;
    const asked: string[] = [];
    const lookup = (m: MintUrl, id: string): Promise<MintKeyset> => {
      asked.push(`${m}|${id}`);
      return id.startsWith('bad') ? Promise.reject(new Error('unknown')) : Promise.resolve(ks(id));
    };
    const g = guardedKeyset(lookup, { burst: 2, refillMs: 1000, now: () => t });
    expect(await g(MINT, 'good')).toMatchObject({ id: 'good' });
    expect(await g(MINT, 'bad1')).toBeUndefined();
    // Bucket empty: neither a new bad id nor a new good id reaches the wallet…
    expect(await g(MINT, 'bad2')).toBeUndefined();
    expect(await g(MINT, 'good2')).toBeUndefined();
    // …but the known id still resolves, as often as asked.
    for (let i = 0; i < 5; i++) expect(await g(MINT, 'good')).toMatchObject({ id: 'good' });
    // Another mint has its own bucket.
    expect(await g('https://other.example' as MintUrl, 'good')).toMatchObject({ id: 'good' });
    t += 1000;
    expect(await g(MINT, 'good2')).toMatchObject({ id: 'good2' });
    expect(asked.filter((a) => a.startsWith(MINT))).toEqual([
      `${MINT}|good`,
      `${MINT}|bad1`,
      `${MINT}|good`,
      `${MINT}|good`,
      `${MINT}|good`,
      `${MINT}|good`,
      `${MINT}|good`,
      `${MINT}|good2`,
    ]);
  });

  it('idle time is not banked: after a long quiet spell the bucket holds `burst` tokens, not more', async () => {
    let t = 0;
    let reached = 0;
    const g = guardedKeyset(
      () => {
        reached++;
        return Promise.reject(new Error('unknown'));
      },
      { burst: 2, refillMs: 1000, now: () => t },
    );
    await g(MINT, 'x0'); // the bucket starts full; one token spent
    t += 1_000_000; // a thousand refill intervals of quiet
    for (let i = 0; i < 10; i++) await g(MINT, `y${String(i)}`);
    expect(reached).toBe(1 + 2);
    expect(() => guardedKeyset(() => Promise.resolve(ks('a')), { burst: 0 })).toThrow();
  });
});

// ------------------------------------------------------------------------ identity

describe('identity: key file + systemd credential', () => {
  async function withKey(): Promise<{ dir: string; keyFile: string; creds: string }> {
    const dir = await scratch();
    const keyFile = path.join(dir, 'identity.key');
    await createKeyFile({ keyFile, passphrase: Buffer.from(PASS), cost: COST });
    const creds = path.join(dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, PASSPHRASE_CREDENTIAL), `${PASS}\n`, { mode: 0o400 });
    return { dir, keyFile, creds };
  }

  it('unlocks with the credential (one trailing newline ignored): the Nostr key and the wallet P2PK key', async () => {
    const { keyFile, creds } = await withKey();
    const id = await unlockIdentity({ keyFile, credentialsDirectory: creds });
    expect(id.pubkey).toBe(signerMod.LocalSigner.pubkeyOf(await readFile(keyFile)));
    expect(id.p2pk).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(id.p2pk).toBe(id.signer.walletP2pk);
    await id.signer.lock();
  });

  it('every refusal names the problem and never the passphrase', async () => {
    const { dir, keyFile, creds } = await withKey();
    const refused = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RuntimeSetupError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).not.toContain(PASS);
    };
    await refused(
      unlockIdentity({ keyFile, credentialsDirectory: undefined }),
      /no systemd credentials/,
    );
    await refused(unlockIdentity({ keyFile, credentialsDirectory: '' }), /no systemd credentials/);
    await refused(
      unlockIdentity({ keyFile, credentialsDirectory: path.join(dir, 'absent') }),
      /seeder-key-passphrase could not be read \(ENOENT\)/,
    );
    await refused(
      unlockIdentity({ keyFile: path.join(dir, 'none.key'), credentialsDirectory: creds }),
      /no key file at .*--keygen/,
    );
    // Wrong passphrase.
    const wrong = path.join(dir, 'wrong');
    await mkdir(wrong, { mode: 0o700 });
    await writeFile(path.join(wrong, PASSPHRASE_CREDENTIAL), 'x'.repeat(40), { mode: 0o400 });
    await refused(
      unlockIdentity({ keyFile, credentialsDirectory: wrong }),
      /did not unlock: bad-passphrase/,
    );
    // Too short a credential.
    const short = path.join(dir, 'short');
    await mkdir(short, { mode: 0o700 });
    await writeFile(path.join(short, PASSPHRASE_CREDENTIAL), 'short\n', { mode: 0o400 });
    await refused(readPassphrase(short), /must hold 16 to 4096 bytes/);
    // A key file others can read.
    await chmod(keyFile, 0o644);
    await refused(
      unlockIdentity({ keyFile, credentialsDirectory: creds }),
      /accessible to group or others/,
    );
    await chmod(keyFile, 0o600);
    // A key file without a wallet key (a plain Nostr signer's file).
    const nostrOnly = path.join(dir, 'nostr-only.key');
    const { file } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from(PASS),
      cost: COST,
    });
    await writeFile(nostrOnly, file, { mode: 0o600 });
    await refused(
      unlockIdentity({ keyFile: nostrOnly, credentialsDirectory: creds }),
      /carries no wallet key/,
    );
  });

  it('createKeyFile never overwrites and refuses a short passphrase', async () => {
    const { keyFile } = await withKey();
    const before = await readFile(keyFile);
    await expect(
      createKeyFile({ keyFile, passphrase: Buffer.from(PASS), cost: COST }),
    ).rejects.toThrow(/never overwrites/);
    expect(await readFile(keyFile)).toEqual(before);
    await expect(
      createKeyFile({ keyFile: `${keyFile}.2`, passphrase: Buffer.from('short'), cost: COST }),
    ).rejects.toThrow(/16 to 4096 bytes/);
  });
});

// ------------------------------------------------------------------------ nostr events

describe('NIP-61 nutzap and kind 10019', () => {
  async function signer(): Promise<signerMod.LocalSigner> {
    const { signer: s } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from(PASS),
      cost: COST,
      walletKey: new Uint8Array(32).fill(9),
    });
    return s;
  }
  const set: LockedProofSet = {
    mint: MINT,
    unit: 'sat',
    lockedTo: CREATOR_P2PK,
    proofs: [
      { ...proof(1), dleq: { e: 'ee', s: '55', r: '77' } },
      { ...proof(2, 4), witness: '{"signatures":["SHOULD-NOT-LEAK"]}' },
    ],
  };
  const core = 'cd'.repeat(32) as CoreKeyHex;
  const video = 'ef'.repeat(32) as NostrEventId;
  const viewer = '9a'.repeat(32) as NostrPubkey;

  it('one signed kind 9321 per call: creator p, mint u, video e, the proofs with DLEQ and without witness — and no viewer', async () => {
    const s = await signer();
    const pool = new nostr.FakeRelayPool();
    const publish = nutzapPublisher({
      signer: s,
      pool,
      relays: [RELAY],
      recipientFor: (k) => (k === CREATOR_P2PK ? CREATOR : undefined),
      videoEventFor: (c) => (c === core ? video : undefined),
      now: () => 1_700_000_000 as never,
    });
    await (publish as (x: LockedProofSet, ctx: unknown) => Promise<void>)(set, {
      core,
      peers: [viewer],
      pays: 2,
    });
    expect(pool.published).toHaveLength(1);
    const ev = pool.published[0]!.event;
    expect(pool.published[0]!.relays).toEqual([RELAY]);
    expect(verifyEvent({ ...ev, tags: ev.tags.map((t) => [...t]) })).toBe(true);
    expect(ev.pubkey).toBe(await s.getPublicKey());
    const z = nostr.parseNutzap(ev);
    expect(z).toMatchObject({ recipient: CREATOR, mint: MINT, videoId: video, claimedAmount: 6 });
    const proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]!) as object);
    expect(proofs).toEqual([
      {
        id: set.proofs[0]!.id,
        amount: 2,
        secret: 'secret-1',
        C: set.proofs[0]!.C,
        dleq: { e: 'ee', s: '55', r: '77' },
      },
      { id: set.proofs[1]!.id, amount: 4, secret: 'secret-2', C: set.proofs[1]!.C },
    ]);
    expect(JSON.stringify(ev)).not.toContain(viewer);
    expect(JSON.stringify(ev)).not.toContain('SHOULD-NOT-LEAK');
    expect(ev.content).toBe('');
  });

  it('rejects (so the engine keeps the PAYs queued) with no recipient, or when every relay refuses', async () => {
    const s = await signer();
    const rejecting = new nostr.FakeRelayPool({ rejectPublish: () => 'blocked: test' });
    const call = (p: nostr.PoolLike, recipient: NostrPubkey | undefined): Promise<void> =>
      (
        nutzapPublisher({ signer: s, pool: p, relays: [RELAY], recipientFor: () => recipient }) as (
          x: LockedProofSet,
          ctx: unknown,
        ) => Promise<void>
      )(set, { core, peers: [], pays: 1 });
    await expect(call(rejecting, CREATOR)).rejects.toThrow(/no relay accepted/);
    const ok = new nostr.FakeRelayPool();
    await expect(call(ok, undefined)).rejects.toThrow(/no creator pubkey/);
    expect(ok.published).toEqual([]);
  });

  it('kind 10019 names the relays, the mints (sat) and the wallet P2PK key, and parses back', async () => {
    const s = await signer();
    const pool = new nostr.FakeRelayPool();
    const ok = await announceNutzapInfo({
      signer: s,
      pool,
      relays: [RELAY],
      mints: [MINT],
      p2pk: s.walletP2pk!,
    });
    expect(ok).toEqual([RELAY]);
    const ev = pool.published[0]!.event;
    expect(ev.kind).toBe(NostrKind.NutzapInfo);
    expect(nostr.parseNutzapInfo(ev)).toMatchObject({
      pubkey: await s.getPublicKey(),
      relays: [RELAY],
      mints: [{ url: MINT, units: ['sat'] }],
      p2pk: s.walletP2pk,
    });
  });
});

// ------------------------------------------------------------------------ mint transport

describe('nodeRawHttp (the mint transport under cashuRequestFn: node:http, never fetch)', () => {
  async function server(
    handle: Parameters<typeof createServer>[1],
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = createServer(handle);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as AddressInfo;
    const close = (): Promise<void> =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => {
          r();
        });
      });
    cleanups.push(close);
    return { url: `http://127.0.0.1:${String(port)}`, close };
  }
  const base = { headers: {}, timeoutMs: 5000, maxBytes: 1024 };

  it('GET and POST round-trip: method, headers, body with Content-Length; status, lower-case headers and body come back', async () => {
    const s = await server((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        res.setHeader('X-Echo-Method', req.method ?? '');
        res.setHeader('Retry-After', '3');
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(
          JSON.stringify({
            body,
            len: req.headers['content-length'] ?? null,
            a: req.headers.accept,
          }),
        );
      });
    });
    const get = await nodeRawHttp({
      ...base,
      url: `${s.url}/v1/info`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    expect(get.status).toBe(200);
    expect(get.headers['x-echo-method']).toBe('GET');
    expect(JSON.parse(get.body)).toEqual({ body: '', len: null, a: 'application/json' });
    const post = await nodeRawHttp({
      ...base,
      url: `${s.url}/v1/swap`,
      method: 'POST',
      body: '{"é":1}',
    });
    expect(post.status).toBe(201);
    expect(post.headers['retry-after']).toBe('3');
    expect(JSON.parse(post.body)).toMatchObject({
      body: '{"é":1}',
      len: String(Buffer.byteLength('{"é":1}')),
    });
  });

  it('never follows a redirect (the 3xx comes back as a status), refuses an oversize body, times out a stalled server, refuses non-http(s)', async () => {
    const s = await server((req, res) => {
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'http://169.254.169.254/latest');
        res.end();
      } else if (req.url === '/big') res.end('x'.repeat(4096));
      else if (req.url === '/stall') res.write('{'); // never ends
    });
    const r = await nodeRawHttp({ ...base, url: `${s.url}/redirect`, method: 'GET' });
    expect(r.status).toBe(302);
    await expect(nodeRawHttp({ ...base, url: `${s.url}/big`, method: 'GET' })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    await expect(
      nodeRawHttp({ ...base, url: `${s.url}/stall`, method: 'GET', timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200 ms/);
    await expect(
      nodeRawHttp({ ...base, url: 'file:///etc/passwd', method: 'GET' }),
    ).rejects.toThrow(/http\(s\)/);
    await expect(
      nodeRawHttp({ ...base, url: 'http://127.0.0.1:1/', method: 'GET' }),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------------------ the state lock

describe('createSeederRuntime: one daemon per data directory', () => {
  async function config(dir: string): Promise<{ config: DaemonConfig; creds: string }> {
    const data = path.join(dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const r = validateDaemonConfig({
      dataDir: data,
      swarm: null,
      relays: [RELAY],
      policy: { satsPerBlock: 1, mints: [MINT], creatorP2pk: CREATOR_P2PK, creatorPubkey: CREATOR },
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    await createKeyFile({ keyFile: r.config.keyFile, passphrase: Buffer.from(PASS), cost: COST });
    const creds = path.join(dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, PASSPHRASE_CREDENTIAL), PASS, { mode: 0o400 });
    return { config: r.config, creds };
  }

  it('a payout that names this node’s own key is refused before anything moves', async () => {
    const dir = await scratch();
    const { config: c, creds } = await config(dir);
    const own = signerMod.LocalSigner.pubkeyOf(await readFile(c.keyFile));
    const bad: DaemonConfig = {
      ...c,
      payout: {
        pubkey: own,
        p2pk: `02${'ab'.repeat(32)}` as CashuP2pkPubkey,
        thresholdSats: 10,
        relays: [RELAY],
      },
    };
    const log = capturedLogger();
    await expect(
      createSeederRuntime(bad, {
        credentialsDirectory: creds,
        logger: log.logger,
        pool: new nostr.FakeRelayPool(),
      }),
    ).rejects.toThrow(/payout names this node’s own key/);
    // The lock was released: a correct config starts.
    const ok = await createSeederRuntime(c, {
      credentialsDirectory: creds,
      logger: log.logger,
      pool: new nostr.FakeRelayPool(),
    });
    expect(ok.payout).toBeNull();
    await ok.close();
  }, 60_000);

  it('a lock held by a live process is refused; a second runtime in this process is refused; a lock whose process is gone (or our own pid from before a reboot) is taken over; close() frees it', async () => {
    const dir = await scratch();
    const { config: c, creds } = await config(dir);
    const log = capturedLogger();
    const opts = {
      credentialsDirectory: creds,
      logger: log.logger,
      pool: new nostr.FakeRelayPool(),
    };
    const lock = path.join(c.seeder.dataDir, 'wallet', 'lock');

    const first = await createSeederRuntime(c, opts);
    await expect(createSeederRuntime(c, opts)).rejects.toThrow(
      /this process already runs a seeder/,
    );
    await first.close();
    await expect(stat(lock)).rejects.toThrow();

    // Another live process holds it.
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    cleanups.push(() => {
      live.kill('SIGKILL');
      return Promise.resolve();
    });
    await writeFile(lock, `${String(live.pid)}\n`, { mode: 0o600 });
    await expect(createSeederRuntime(c, opts)).rejects.toThrow(
      new RegExp(`another seeder \\(pid ${String(live.pid)}\\) holds`),
    );
    live.kill('SIGKILL');
    await new Promise((r) => live.once('exit', r));

    // Now that process is gone: taken over.
    const second = await createSeederRuntime(c, opts);
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.pid));
    await second.close();

    // Our own pid left in the file (a restart that got its old pid back after a reboot).
    await writeFile(lock, `${String(process.pid)}\n`, { mode: 0o600 });
    const third = await createSeederRuntime(c, opts);
    await third.close();
  }, 60_000);
});
