/**
 * ADR 0016 (issue #3): the desktop's recovery phrase flows end to end against fakes of lane N1's
 * seam (`support/fake-recovery.ts`) — a real `MainBridge` whose "main" answers prompts and native
 * confirms by script, a real `LocalSigner` (NIP-44 to self), real files in a temp userData, and
 * core's `FakeRelayPool`. Every test ends with the canary: no word, no index list and no entropy
 * reached the logs, a result or a progress event.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MintUrl, NostrPubkey, RelayUrl, Sats, Signer, UnixSeconds } from '@sovit/core';
import { nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';

import { isConfirmForm, isPromptForm } from '../../ipc/guards.js';
import type {
  ConfirmForm,
  HostOut,
  PromptAnswer,
  PromptForm,
  RecoveryProgressWire,
} from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import { entropyHex } from '../recovery/core.js';
import { readEnvelope, recoveryPath } from '../recovery/files.js';
import type { PlaneSeed } from '../recovery/service.js';
import { CONFIRM_ATTEMPTS, RecoveryService, reasonOf } from '../recovery/service.js';
import { MainBridge } from '../signer/main-bridge.js';
import { CANCEL_LIMIT, UNLOCK_ATTEMPTS } from '../signer/desktop-signer.js';
import { FakeRecoveryCore, entropyHexOf, wordsOf } from './support/fake-recovery.js';

const MINT_A = 'https://mint-a.recovery.test' as MintUrl;
const MINT_B = 'https://mint-b.recovery.test' as MintUrl;
const RELAY = 'wss://relay.recovery.test' as RelayUrl;
const PASS = 'correct horse battery staple';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A fixed first phrase: "legal winner thank year wave sausage worth useful legal winner thank yellow". */
const ENTROPY_1 = new Uint8Array(16).fill(0x7f);
const ENTROPY_2 = new Uint8Array(16).fill(0x80);
const ENTROPY_3 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface FakePlane {
  readonly pubkey: NostrPubkey;
  readonly mints: readonly MintUrl[];
  readonly seeded: walletMod.SeededWallet | undefined;
  readonly wallet: {
    balances(): Promise<ReadonlyMap<MintUrl, Sats>>;
    mints(): Promise<readonly MintUrl[]>;
  };
  close(): void;
}

interface World {
  readonly svc: RecoveryService;
  readonly core: FakeRecoveryCore;
  readonly signer: Signer;
  readonly pubkey: NostrPubkey;
  readonly dir: string;
  readonly pool: nostr.FakeRelayPool;
  readonly log: ReturnType<typeof memoryLogger>;
  readonly asked: PromptForm[];
  readonly confirms: ConfirmForm[];
  readonly out: HostOut[];
  readonly progress: RecoveryProgressWire[];
  /** Each reopen: did `beforeOpen` write this identity's phrase file (with no plane open)? */
  readonly reopens: { savedWithNoPlane: boolean }[];
  plane(): FakePlane | undefined;
  /** Replace the prompt script (a promise holds the window open). */
  answer: (f: PromptForm) => PromptAnswer | null | Promise<PromptAnswer | null>;
  confirm: (f: ConfirmForm) => boolean;
  balances: Map<MintUrl, number>;
  clock: number;
  openPlane(): Promise<void>;
}

async function world(
  o: { kind?: 'local' | 'nip46'; core?: FakeRecoveryCore | null } = {},
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'nf-n2-svc-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'wallet');
  const core = o.core === null ? undefined : (o.core ?? new FakeRecoveryCore());
  const { signer: local, file } = await signerMod.LocalSigner.create({
    passphrase: enc(PASS),
    cost: signerMod.minimumCost(),
  });
  const pubkey = await local.getPublicKey();
  // A NIP-46-like signer: the same key, another kind (no local passphrase to re-check).
  const signer: Signer =
    o.kind === 'nip46'
      ? ({
          kind: 'nip46',
          getPublicKey: () => local.getPublicKey(),
          signEvent: (e) => local.signEvent(e),
          nip44Encrypt: (pk, t) => local.nip44Encrypt(pk, t),
          nip44Decrypt: (pk, c) => local.nip44Decrypt(pk, c),
        } as Signer)
      : local;
  const pool = new nostr.FakeRelayPool();
  const log = memoryLogger('debug');
  const out: HostOut[] = [];
  const w = {} as World;
  w.answer = () => null;
  w.confirm = () => false;
  w.balances = new Map();
  w.clock = 1_000_000;
  const asked: PromptForm[] = [];
  const confirms: ConfirmForm[] = [];
  const bridge: MainBridge = new MainBridge({
    post: (m) => {
      out.push(m);
      if (m.kind === 'prompt') {
        expect(isPromptForm(m.form), m.form.kind).toBe(true);
        asked.push(structuredClone(m.form));
        void Promise.resolve(w.answer(m.form)).then((a) => {
          bridge.onPromptAnswer(m.req, a);
        });
      } else if (m.kind === 'confirm') {
        expect(isConfirmForm(m.form)).toBe(true);
        confirms.push(structuredClone(m.form));
        const ok = w.confirm(m.form);
        queueMicrotask(() => {
          bridge.onConfirmResult(m.req, ok);
        });
      }
    },
  });
  let plane: FakePlane | undefined;
  const reopens: { savedWithNoPlane: boolean }[] = [];
  const progress: RecoveryProgressWire[] = [];
  const makePlane = (seed: PlaneSeed | undefined): FakePlane => {
    if (seed !== undefined) seed.core.seedOption(seed.material);
    const seeded = seed?.core.seeded({} as walletMod.CashuWallet);
    return {
      pubkey,
      mints: [MINT_A],
      seeded,
      wallet: {
        balances: () =>
          Promise.resolve(new Map(w.balances) as unknown as ReadonlyMap<MintUrl, Sats>),
        mints: () => Promise.resolve([MINT_A, MINT_B]),
      },
      close: () => {
        seed?.material.seed.wipe();
      },
    };
  };
  const svc: RecoveryService = new RecoveryService({
    core,
    dir,
    bridge,
    signer: () => signer,
    plane: () => plane as unknown as MoneyPlane | undefined,
    reopenMoney: async (between) => {
      const old = plane;
      plane = undefined;
      old?.close();
      let err: unknown;
      let failed = false;
      const before = await readFile(recoveryPath(dir, pubkey), 'utf8').catch(() => null);
      if (between !== undefined)
        try {
          await between();
        } catch (e) {
          failed = true;
          err = e;
        }
      const after = await readFile(recoveryPath(dir, pubkey), 'utf8').catch(() => null);
      // `plane` is read back through the getter: `beforeOpen` could have reopened it.
      reopens.push({
        savedWithNoPlane: w.plane() === undefined && after !== null && after !== before,
      });
      plane = makePlane(await svc.seedFor(signer, pubkey));
      if (failed) throw err;
    },
    checkPassphrase: async (pass, pk) => {
      try {
        const s = await signerMod.LocalSigner.unlock(file, pass);
        const ok = (await s.getPublicKey()) === pk;
        await s.lock();
        return ok;
      } catch {
        return false;
      }
    },
    relays: { pool, write: () => [RELAY], read: () => [RELAY] },
    log,
    now: () => 1_760_000_000 as UnixSeconds,
    clock: () => w.clock,
  });
  svc.onProgress((p) => progress.push(p));
  if (core !== undefined) core.wallet.balances.clear();
  Object.assign(w, {
    svc,
    core,
    signer,
    pubkey,
    dir,
    pool,
    log,
    asked,
    confirms,
    out,
    progress,
    reopens,
    plane: () => plane,
    openPlane: async () => {
      plane = makePlane(await svc.seedFor(signer, pubkey));
    },
  });
  await w.openPlane();
  return w;
}

/** Plays the user through a new phrase: "I wrote them down", then the right words back. */
function userWhoWritesItDown(w: World, opts: { later?: boolean; wrongWords?: boolean } = {}): void {
  let shown: readonly number[] = [];
  w.answer = (f) => {
    if (f.kind === 'recovery-show') {
      shown = [...f.words];
      return { kind: 'recovery-show', done: opts.later !== true };
    }
    if (f.kind === 'recovery-confirm')
      return {
        kind: 'recovery-confirm',
        words: f.positions.map((p) =>
          opts.wrongWords === true ? ((shown[p] ?? 0) + 1) % 2048 : (shown[p] ?? 0),
        ),
      };
    if (f.kind === 'recovery-reauth') return { kind: 'secret', value: enc(PASS) };
    return null;
  };
}

/** The canary: nothing secret about any phrase in logs, results, progress or errors. */
function expectNoPhrase(w: World, extra: unknown[] = []): void {
  const phrases = [...w.core.phrases.generated, ENTROPY_1, ENTROPY_2, ENTROPY_3];
  const logs = w.log.lines.map((l) => JSON.stringify(l)).join('\n');
  const sink = `${logs}\n${JSON.stringify(w.progress)}\n${JSON.stringify(extra)}`;
  for (const e of phrases) {
    const indices = w.core.phrases.toIndices(e as walletMod.RecoveryEntropy);
    const words = wordsOf(indices);
    expect(sink).not.toContain(entropyHexOf(e));
    expect(sink).not.toContain(JSON.stringify(indices));
    expect(sink).not.toContain(indices.join(','));
    // No run of three of its words in order (a single common word may appear in a sentence).
    for (let i = 0; i + 3 <= words.length; i++)
      expect(sink).not.toContain(words.slice(i, i + 3).join(' '));
  }
}

describe('setup: a new phrase (ADR 0016 §1, D2, D5)', () => {
  it('shows indices, seals the entropy NIP-44 to self (0600 in 0700) while no plane holds the wallet, publishes the relay copy, confirms three words, reissues after the fee confirm', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    w.balances.set(MINT_A, 1_000);
    w.balances.set(MINT_B, 0);
    w.core.wallet.balances.set(MINT_A, 1_000);
    w.core.wallet.plans.set(MINT_A, { inputs: 4, feeSats: 2 });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    expect((await w.svc.status()).state).toBe('not-on-device');

    const r = await w.svc.setup();

    // The window got 12 indices — exactly the phrase — and never a word.
    const show = w.asked.find((f) => f.kind === 'recovery-show');
    expect(show).toEqual({
      kind: 'recovery-show',
      words: w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy),
      again: false,
    });
    const conf = w.asked.find((f) => f.kind === 'recovery-confirm');
    expect(conf?.kind === 'recovery-confirm' && conf.positions).toHaveLength(3);
    // Saved during the reopen, with no plane open.
    expect(w.reopens).toEqual([{ savedWithNoPlane: true }]);
    // The sealed file: 0600 in a 0700 directory, the entropy NIP-44 to self.
    const path = recoveryPath(w.dir, w.pubkey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(w.dir)).mode & 0o777).toBe(0o700);
    const env = await readEnvelope(path);
    expect(env).toMatchObject({ confirmed: true, reissued: true, relayCopy: true, replaces: null });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(entropyHex(ENTROPY_1));
    const plain = JSON.parse(await w.signer.nip44Decrypt(w.pubkey, env?.sealed ?? '')) as unknown;
    expect(plain).toEqual({ v: 1, entropy: entropyHex(ENTROPY_1), created: 1_760_000_000 });
    // The relay copy: kind 30078, d = nutflix/nut13/<device>, the same ciphertext, no other tag.
    const copies = w.pool.published.filter((p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND);
    expect(copies).toHaveLength(1);
    const ev = copies[0]?.event;
    expect(ev?.tags).toEqual([['d', `${walletMod.RECOVERY_D_PREFIX}${env?.device ?? ''}`]]);
    expect(ev?.content).toBe(env?.sealed);
    expect(ev?.pubkey).toBe(w.pubkey);
    // The plane now derives from THIS phrase.
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string; wiped: boolean };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_1));
    expect(seed.wiped).toBe(false);
    // The fee was shown natively before anything moved, then the reissue ran.
    expect(w.confirms).toEqual([
      {
        kind: 'recovery-reissue',
        plans: [{ mint: MINT_A, amount: 1_000, inputs: 4, feeSats: 2 }],
      },
    ]);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
    expect(r).toEqual({
      status: { state: 'covered', reissuePending: false, relayCopy: true },
      reissuedSats: 998,
      feeSats: 2,
      reissueFailed: 0,
    });
    // The entropy the fake core handed out was wiped after use.
    expect(w.core.phrases.generated).toHaveLength(1);
    expectNoPhrase(w, [r]);
  });

  it('closing the window (or Escape) discards the phrase: nothing saved, nothing published, no reopen', async () => {
    const w = await world();
    w.answer = () => null;
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(w.dir).catch(() => [])).toEqual([]);
    expect(w.pool.published).toEqual([]);
    expect(w.reopens).toEqual([]);
    expect((await w.svc.status()).state).toBe('not-on-device');
    expectNoPhrase(w);
  });

  it('"Later": saved and published but not confirmed; the fee declined leaves the reissue pending, and setup then finishes only the reissue', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_2);
    w.balances.set(MINT_A, 500);
    w.core.wallet.balances.set(MINT_A, 500);
    w.core.wallet.plans.set(MINT_A, { inputs: 2, feeSats: 1 });
    userWhoWritesItDown(w, { later: true });
    w.confirm = () => false;
    const r = await w.svc.setup();
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
    expect(r.status).toEqual({ state: 'not-confirmed', reissuePending: true, relayCopy: true });
    expect(r.reissueFailed).toBe(1);
    expect(w.core.wallet.reissued).toEqual([]);

    // Again: no new phrase, no window with words — only the reissue.
    w.asked.length = 0;
    w.confirm = () => true;
    const r2 = await w.svc.setup();
    expect(w.asked).toEqual([]);
    expect(w.core.phrases.generated).toHaveLength(1);
    expect(r2.status).toEqual({ state: 'not-confirmed', reissuePending: false, relayCopy: true });
    expect(r2.reissuedSats).toBe(499);
    expectNoPhrase(w, [r, r2]);
  });

  it('three wrong confirmations: kept, not confirmed', async () => {
    const w = await world();
    userWhoWritesItDown(w, { wrongWords: true });
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(w.asked.filter((f) => f.kind === 'recovery-confirm')).toHaveLength(CONFIRM_ATTEMPTS);
    expect(w.asked.filter((f) => f.kind === 'recovery-confirm').map((f) => f.retry)).toEqual([
      false,
      true,
      true,
    ]);
    expect(r.status.state).toBe('not-confirmed');
    expectNoPhrase(w, [r]);
  });

  it('relays refusing the copy: sealed on this device only, and the status says so', async () => {
    const w = await world();
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays) =>
      Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'blocked' })));
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(r.status).toEqual({ state: 'covered', reissuePending: false, relayCopy: false });
    expect(w.log.lines.some((l) => l.msg.includes('reached no relay'))).toBe(true);
  });

  it('a phrase file that does not open is never replaced (status unreadable, setup forbidden)', async () => {
    const w = await world();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(w.dir, { recursive: true, mode: 0o700 });
    await writeFile(recoveryPath(w.dir, w.pubkey), '{"not":"an envelope"}', { mode: 0o600 });
    await w.openPlane();
    expect((await w.svc.status()).state).toBe('unreadable');
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readFile(recoveryPath(w.dir, w.pubkey), 'utf8')).toBe('{"not":"an envelope"}');
    expect(w.log.lines.some((l) => l['reason'] === 'recovery-unreadable')).toBe(true);
  });

  it('a seed the wallet did not take: the phrase is on this device but the status says unreadable, never covered', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.core.takesSeed = false;
    const r = await w.svc.setup();
    expect(w.plane()?.seeded).toBeUndefined();
    expect(r.status.state).toBe('unreadable');
    expect((await w.svc.status()).state).toBe('unreadable');
    // Nothing was reissued into outputs the phrase could not restore.
    expect(w.core.wallet.reissued).toEqual([]);
  });

  it('a phrase sealed to another identity does not open: the plane derives nothing from it', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const env = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    const { signer: other } = await signerMod.LocalSigner.create({
      passphrase: enc('another passphrase!'),
      cost: signerMod.minimumCost(),
    });
    const foreign = await other.nip44Encrypt(
      await other.getPublicKey(),
      JSON.stringify({ v: 1, entropy: entropyHex(ENTROPY_3), created: 1 }),
    );
    await writeFile(recoveryPath(w.dir, w.pubkey), JSON.stringify({ ...env, sealed: foreign }), {
      mode: 0o600,
    });
    const before = w.core.materials.length;
    await w.openPlane();
    expect(w.core.materials.length).toBe(before);
    expect(w.plane()?.seeded).toBeUndefined();
    expect((await w.svc.status()).state).toBe('unreadable');
  });
});

describe('rotation, show again (ADR 0016 §1: re-authentication first)', () => {
  it('a finished phrase is replaced only after the passphrase; the old one is kept as .retired and its relay copy retired once the reissue completed', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const first = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    w.asked.length = 0;
    const r = await w.svc.setup();
    expect(w.asked[0]).toEqual({ kind: 'recovery-reauth', retry: false });
    const second = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(second?.device).not.toBe(first?.device);
    expect(second?.replaces).toBeNull();
    const names = await readdir(w.dir);
    expect(names).toContain(`recovery-${w.pubkey}.${first?.device ?? ''}.retired`);
    // The old copy: blanked and deleted (NIP-09), best effort.
    const d = `${walletMod.RECOVERY_D_PREFIX}${first?.device ?? ''}`;
    const blank = w.pool.published.find(
      (p) =>
        p.event.kind === walletMod.RECOVERY_RELAY_KIND &&
        p.event.content === '' &&
        p.event.tags[0]?.[1] === d,
    );
    expect(blank).toBeDefined();
    const deletion = w.pool.published.find((p) => p.event.kind === 5);
    expect(deletion?.event.tags).toContainEqual([
      'a',
      `${String(walletMod.RECOVERY_RELAY_KIND)}:${w.pubkey}:${d}`,
    ]);
    // The plane derives from the NEW phrase.
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_2));
    expect(r.status.state).toBe('covered');
    expectNoPhrase(w, [r]);
  });

  it('a replacement whose reissue was declined keeps `replaces` (the old copy stays until the reissue completes)', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const first = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    w.balances.set(MINT_A, 100);
    w.core.wallet.balances.set(MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 1, feeSats: 1 });
    w.confirm = () => false;
    await w.svc.setup();
    const second = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(second).toMatchObject({ reissued: false, replaces: first?.device });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(false);
    w.confirm = () => true;
    await w.svc.setup();
    expect(await readEnvelope(recoveryPath(w.dir, w.pubkey))).toMatchObject({
      reissued: true,
      replaces: null,
    });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(true);
  });

  it('a wrong passphrase three times is `forbidden`; nothing is shown or replaced', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const before = await readFile(recoveryPath(w.dir, w.pubkey), 'utf8');
    w.asked.length = 0;
    w.answer = (f) =>
      f.kind === 'recovery-reauth' ? { kind: 'secret', value: enc('wrong!') } : null;
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.asked.map((f) => f.kind)).toEqual(Array(UNLOCK_ATTEMPTS).fill('recovery-reauth'));
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readFile(recoveryPath(w.dir, w.pubkey), 'utf8')).toBe(before);
    expect(w.asked.some((f) => f.kind === 'recovery-show')).toBe(false);
  });

  it('show again: the same indices after the passphrase; an unconfirmed backup can be confirmed then', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_3);
    userWhoWritesItDown(w, { later: true });
    w.confirm = () => true;
    await w.svc.setup();
    expect((await w.svc.status()).state).toBe('not-confirmed');
    userWhoWritesItDown(w);
    w.asked.length = 0;
    await w.svc.show();
    expect(w.asked.map((f) => f.kind)).toEqual([
      'recovery-reauth',
      'recovery-show',
      'recovery-confirm',
    ]);
    expect(w.asked[1]).toEqual({
      kind: 'recovery-show',
      words: w.core.phrases.toIndices(ENTROPY_3 as walletMod.RecoveryEntropy),
      again: true,
    });
    expect((await w.svc.status()).state).toBe('covered');
    expectNoPhrase(w);
  });

  it('a remote signer (NIP-46) re-authenticates with main’s native confirm instead', async () => {
    const w = await world({ kind: 'nip46' });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    w.asked.length = 0;
    w.confirms.length = 0;
    w.confirm = (f) => f.kind !== 'recovery-reveal';
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.confirms).toEqual([{ kind: 'recovery-reveal' }]);
    expect(w.asked).toEqual([]);
    w.confirm = () => true;
    await w.svc.show();
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
  });
});

describe('restore (ADR 0016 §5)', () => {
  it('needs this device’s phrase in use first', async () => {
    const w = await world();
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(w.asked).toEqual([]);
  });

  it('the relay copies are read ONLY by an explicit restore: never at startup, setup or show', async () => {
    const w = await world();
    const reads = (): number =>
      w.pool.queries.filter((q) => q.filter.kinds?.includes(walletMod.RECOVERY_RELAY_KIND) === true)
        .length;
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    await w.openPlane();
    await w.svc.status();
    await w.svc.show();
    expect(reads()).toBe(0);
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [] } : null;
    await w.svc.restore();
    expect(reads()).toBe(1);
    expect(w.pool.queries.at(-1)?.filter).toMatchObject({
      kinds: [walletMod.RECOVERY_RELAY_KIND],
      authors: [w.pubkey],
    });
  });

  it('scans this device’s phrases (current + retired), every relay copy the identity decrypts and a typed phrase — once each — with progress and one row per mint', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup(); // ENTROPY_1
    await w.svc.setup(); // rotation: ENTROPY_2 current, ENTROPY_1 retired
    // Another device's copy on the relays (sealed to the same identity), plus a duplicate of
    // ENTROPY_1 and junk.
    const other = await w.signer.nip44Encrypt(
      w.pubkey,
      JSON.stringify({ v: 1, entropy: entropyHex(ENTROPY_3), created: 5 }),
    );
    await w.pool.publish(
      [RELAY],
      await w.signer.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: 1_760_000_100,
        tags: [['d', `${walletMod.RECOVERY_D_PREFIX}${'ab'.repeat(16)}`]],
        content: other,
      }),
    );
    await w.pool.publish(
      [RELAY],
      await w.signer.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: 1_760_000_101,
        tags: [['d', `${walletMod.RECOVERY_D_PREFIX}${'cd'.repeat(16)}`]],
        content: 'not nip44',
      }),
    );
    const typed = w.core.phrases.toIndices(ENTROPY_3 as walletMod.RecoveryEntropy);
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [...typed] } : null;
    w.core.wallet.restores.set(entropyHex(ENTROPY_1), {
      [MINT_A]: { outcome: 'restored', restoredSats: 40 },
    });
    w.core.wallet.restores.set(entropyHex(ENTROPY_3), {
      [MINT_A]: { outcome: 'restored', restoredSats: 2 },
      [MINT_B]: { outcome: 'unsupported', restoredSats: 0 },
    });
    w.progress.length = 0;
    const r = await w.svc.restore();
    const scanned = w.core.wallet.restoreCalls.map((c) => c.entropyHex).sort();
    expect(scanned).toEqual(
      [entropyHex(ENTROPY_1), entropyHex(ENTROPY_2), entropyHex(ENTROPY_3)].sort(),
    );
    expect(w.core.wallet.restoreCalls.every((c) => c.liveDuringRestore)).toBe(true);
    expect(w.core.wallet.restoreCalls[0]?.mints).toEqual([MINT_A, MINT_B]);
    expect(r).toEqual({
      phrases: 3,
      reports: [
        { mint: MINT_A, outcome: 'restored', restoredSats: 42 },
        { mint: MINT_B, outcome: 'unsupported', restoredSats: 0 },
      ],
    });
    // Every seed made for the restore was wiped after its pass.
    const restoreSeeds = w.core.phrases.seeds.slice(-3);
    expect(restoreSeeds.every((s) => s.wiped)).toBe(true);
    // Progress: numbers and the user's own mint URLs only.
    expect(w.progress.length).toBeGreaterThan(0);
    for (const p of w.progress) {
      expect(Object.keys(p).sort()).toEqual([
        'keysets',
        'keysetsDone',
        'mint',
        'phrase',
        'phrases',
      ]);
      expect(p.phrases).toBe(3);
    }
    expect(w.log.lines.find((l) => l.msg === 'restoring from recovery phrases')).toMatchObject({
      phrases: 3,
      relayUnreadable: 1,
      localUnreadable: 0,
    });
    expectNoPhrase(w, [r]);
  });

  it('a typed phrase with a bad checksum is refused by core (the problem named, never a word)', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const bad = [...w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy)];
    bad[11] = ((bad[11] ?? 0) + 1) % 2048;
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: bad } : null;
    const err = await w.svc.restore().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-argument' });
    expect((err as Error).message).toMatch(/\(checksum\)$/);
    expect(w.core.wallet.restoreCalls).toEqual([]);
    expectNoPhrase(w, [(err as Error).message]);
  });

  it('a pass that fails marks its mints unreachable and the others still run', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    w.core.wallet.failRestore.add(entropyHex(ENTROPY_1));
    const typed = w.core.phrases.toIndices(ENTROPY_2 as walletMod.RecoveryEntropy);
    w.core.wallet.restores.set(entropyHex(ENTROPY_2), {
      [MINT_B]: { outcome: 'restored', restoredSats: 7 },
    });
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [...typed] } : null;
    const r = await w.svc.restore();
    expect(r.reports).toEqual([
      { mint: MINT_A, outcome: 'unreachable', restoredSats: 0 },
      { mint: MINT_B, outcome: 'restored', restoredSats: 7 },
    ]);
  });
});

describe('guard rails', () => {
  it('without N1’s code: status unavailable, every flow refused, nothing derived', async () => {
    const w = await world({ core: null });
    expect(await w.svc.status()).toEqual({
      state: 'unavailable',
      reissuePending: false,
      relayCopy: false,
    });
    for (const f of [() => w.svc.setup(), () => w.svc.show(), () => w.svc.restore()])
      await expect(f()).rejects.toMatchObject({ code: 'payments-unavailable' });
    expect(await w.svc.seedFor(w.signer, w.pubkey)).toBeUndefined();
  });

  it('dismissed windows are throttled like connect; one flow at a time', async () => {
    const w = await world();
    w.answer = () => null;
    for (let i = 0; i < CANCEL_LIMIT; i++)
      await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'rate-limited' });
    w.clock += 61_000;
    let release: (a: PromptAnswer | null) => void = () => undefined;
    w.answer = () =>
      new Promise<PromptAnswer | null>((res) => {
        release = res;
      });
    w.asked.length = 0;
    const first = w.svc.setup();
    await vi.waitFor(() => {
      expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
    });
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'rate-limited' });
    release(null);
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a core error whose message carries words is `internal` to the renderer and only its code is logged', async () => {
    const w = await world();
    const words = wordsOf(w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy)).join(
      ' ',
    );
    w.core.phrases.generate = () => {
      throw new Error(`invalid-argument: ${words}`);
    };
    const err = await w.svc.setup().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal' });
    expect((err as Error).message).not.toContain(words.split(' ')[0] ?? '');
    expect(w.log.lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain(words);
    expectNoPhrase(w, [(err as Error).message]);
  });

  it('reasonOf passes only allow-listed codes and error names', () => {
    expect(reasonOf(new Error('counters-unreadable: damaged'))).toBe('counters-unreadable');
    expect(reasonOf(new Error('abandon: ability able about'))).toBe('error');
    expect(reasonOf(Object.assign(new Error('x'), { name: 'RecoveryPhraseError' }))).toBe(
      'RecoveryPhraseError',
    );
    expect(reasonOf(Object.assign(new Error('x'), { name: 'abandon ability' }))).toBe('error');
    expect(reasonOf('zoo: zoo')).toBe('error');
  });

  it('a reissue plan for another mint, or one whose fee eats the amount, is never asked', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 3);
    w.core.wallet.balances.set(MINT_A, 3);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 3 });
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r.status.reissuePending).toBe(false);
  });
});
