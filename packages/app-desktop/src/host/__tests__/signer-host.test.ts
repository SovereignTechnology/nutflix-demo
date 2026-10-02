/**
 * The signer flow through the whole host (ADR 0013): a renderer call names a kind, the host asks
 * "main" (this test, answering `prompt` HostOuts with `prompt-answer` HostIns), the key is made,
 * the money plane opens on the in-process TestMint, the worker is RESTARTED with the new
 * signer's payments in its init, subscribers hear `signer.status`, and a lock restarts it again
 * without them.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { mocks, signer as signerMod } from '@sovit/core';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut, PromptAnswer, PromptForm, ReplyMsg, SessionId } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import type { WorkerInit } from '../../ipc/worker-protocol.js';
import { memoryLogger } from '../log.js';
import { MAX_TAIL_BLOCKS, TAIL_DIR, TAIL_TTL_MS, TailBook } from '../tails.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { FakeWorkerOptions } from './support/fake-worker.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';

const kit = await coreTestKit();

const MINT = 'https://mint.signer-host.test' as MintUrl;
const PASS = 'a long enough passphrase';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

let nextId = 1;
async function invoke(rr: Rig, method: string, args: unknown[]): Promise<ReplyMsg> {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc: 3, msg: { v: IPC_V, id, method, args } });
  const out = await rr.until(
    (o): o is Extract<HostOut, { kind: 'reply' }> =>
      o.kind === 'reply' && o.wc === 3 && o.msg.id === id,
    `reply to ${method}`,
    20_000, // argon2id at the INTERACTIVE floor, plus a new wallet on the TestMint
  );
  return out.msg;
}

function answering(script: (f: PromptForm) => PromptAnswer | null, asked: PromptForm[]) {
  return (o: HostOut, host: () => { handle(m: unknown): void }): void => {
    if (o.kind === 'prompt') {
      asked.push(o.form);
      const answer = script(o.form);
      queueMicrotask(() => {
        host().handle({ kind: 'prompt-answer', req: o.req, answer });
      });
    } else if (o.kind === 'keychain') {
      queueMicrotask(() => {
        host().handle({ kind: 'keychain-result', req: o.req, ok: false, value: null });
      });
    }
  };
}

const initOf = (rr: Rig, i: number): WorkerInit =>
  rr.spawned[i]?.received.find((m) => m.m === 'init')?.a as WorkerInit;

describe('the desktop signer through the host (ADR 0013)', () => {
  it('connect → key made in the prompt, wallet on the mint, worker restarted with payments; lock → without', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x44) });
    const asked: PromptForm[] = [];
    r = await rig({
      mintRequest: () => mint.request,
      signerCost: signerMod.minimumCost(),
      onOut: answering((f) => {
        if (f.kind === 'local-setup')
          return { kind: 'local-setup', method: 'passphrase', flow: 'generate' };
        if (f.kind === 'new-passphrase' || f.kind === 'unlock-passphrase')
          return { kind: 'secret', value: new TextEncoder().encode(PASS) };
        return null;
      }, asked),
    });
    await r.host.adapter.updateSettings({ defaultMints: [MINT] });
    await r.ready();
    expect(initOf(r, 0).payments).toBeUndefined();

    // Before any signer: honest refusals, and the info the Settings screen reads.
    const me0 = await invoke(r, 'me', []);
    expect(me0.ok && me0.result).toBeNull();
    const bal0 = await invoke(r, 'wallet.balance', [MINT]);
    expect(!bal0.ok && bal0.error.code).toBe('payments-unavailable');
    const info0 = await invoke(r, 'desktop.signer.info', []);
    expect(info0.ok && info0.result).toEqual({
      method: null,
      hasLocalKey: false,
      keychain: false,
      remembered: false,
    });

    r.host.handle({
      kind: 'sub',
      wc: 3,
      msg: { v: IPC_V, op: 'sub', subId: 41, topic: { t: 'signer.status' } },
    });
    const connected = await invoke(r, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(connected.ok).toBe(true);
    const pubkey = connected.ok ? (connected.result as { pubkey: string }).pubkey : '';
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(asked.map((f) => f.kind)).toEqual(['local-setup', 'new-passphrase']);

    // The worker was restarted; its new init carries this signer's payments.
    await eventually(() => r?.spawned.length === 2, 'the worker restart');
    await r.ready();
    expect(r.spawned[0]?.destroyed).toBe(true);
    expect(initOf(r, 1).payments).toMatchObject({ pubkey, mints: [MINT] });

    // Subscribers heard it; the wallet answers; writes have a signer.
    const ev = await r.until(
      (o): o is Extract<HostOut, { kind: 'event' }> => o.kind === 'event' && o.msg.subId === 41,
      'signer.status event',
    );
    expect(ev.msg.payload).toMatchObject({ kind: 'local', pubkey, locked: false });
    const bal = await invoke(r, 'wallet.balance', [MINT]);
    expect(bal.ok && bal.result).toBe(0);
    expect(r.host.adapter.wallet).toBeDefined();

    // Lock: the worker restarts again, without payments; the wallet is gone.
    const locked = await invoke(r, 'desktop.signer.lock', []);
    expect(locked.ok).toBe(true);
    await eventually(() => r?.spawned.length === 3, 'the second restart');
    await r.ready();
    expect(initOf(r, 2).payments).toBeUndefined();
    const bal2 = await invoke(r, 'wallet.balance', [MINT]);
    expect(!bal2.ok && bal2.error.code).toBe('payments-unavailable');
    const st = await invoke(r, 'signer', []);
    expect(st.ok && st.result).toMatchObject({ pubkey, locked: true });

    // Everything the host sent main was a valid, clonable HostOut — and no secret went out.
    for (const o of r.out) {
      expect(isHostOut(o), o.kind).toBe(true);
      expect(structuredClone(o)).toEqual(o);
    }
    const everything = JSON.stringify(r.out);
    expect(everything).not.toContain(PASS);
    expect(r.log.lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain(PASS);
  }, 30_000);

  it('a cancelled prompt answers `cancelled` and leaves the worker alone', async () => {
    const asked: PromptForm[] = [];
    r = await rig({ onOut: answering(() => null, asked) });
    await r.ready();
    const res = await invoke(r, 'desktop.signer.connect', [{ kind: 'nip46' }]);
    expect(!res.ok && res.error.code).toBe('cancelled');
    expect(asked).toEqual([{ kind: 'bunker', keychain: false }]);
    expect(r.spawned).toHaveLength(1);
  });

  it('--dev-mocks keeps the fixed viewer identity: the flow is refused', async () => {
    r = await rig({ flags: { devMocks: true } });
    const res = await invoke(r, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(!res.ok && res.error.code).toBe('forbidden');
    expect(r.out.some((o) => o.kind === 'prompt')).toBe(false);
  });
});

// Independent review (lane P2-owed-viewer, MEDIUM): on the production signer path the quit lost
// the tails of the sessions it closed. `Host.shutdown` closed the sessions, then `stop()` — whose
// signer flow closes the money plane and DROPS it before its first await — and then asked the
// adapter to flush the tails of `money()`, by then undefined: nothing was awaited and the process
// exited while the writes were in flight. Every earlier quit test used an injected identity.
describe('quit on the signer flow’s money plane waits for its tail authorisations (ADR 0018 amendment)', () => {
  async function playing(worker: FakeWorkerOptions) {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x45) });
    const rr = await rig({
      mintRequest: () => mint.request,
      signerCost: signerMod.minimumCost(),
      worker,
      onOut: answering((f) => {
        if (f.kind === 'local-setup')
          return { kind: 'local-setup', method: 'passphrase', flow: 'generate' };
        if (f.kind === 'new-passphrase' || f.kind === 'unlock-passphrase')
          return { kind: 'secret', value: new TextEncoder().encode(PASS) };
        return null;
      }, []),
    });
    r = rr;
    await rr.host.adapter.updateSettings({ defaultMints: [MINT] });
    await rr.ready();
    const connected = await invoke(rr, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(connected.ok).toBe(true);
    const pubkey = (
      connected.ok ? (connected.result as { pubkey: string }).pubkey : ''
    ) as NostrPubkey;
    await eventually(() => rr.spawned.length === 2, 'the worker restart');
    await rr.ready();
    // Money at the video's mint, so the play goes ahead.
    const wallet = rr.host.adapter.wallet;
    const q = await wallet.mintQuote(MINT, 500 as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    const base = mocks.VIDEOS[0]!;
    const creatorP2pk = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x46))).toString(
      'hex',
    ) as CashuP2pkPubkey;
    const [seeded] = await seedVideos(kit, rr.pool, new kit.TestSigner(), [
      { ...base, price: { ...base.price, satsPerBlock: 2 as Sats, mints: [MINT], creatorP2pk } },
    ]);
    const played = await invoke(rr, 'play', [seeded!.video.id]);
    expect(played.ok).toBe(true);
    const tailFile = join(rr.userData, TAIL_DIR, `${pubkey}.json`);
    // R2: while it plays, the session has only its crash tail (provisional) on disk — no tail.
    await eventually(() => existsSync(tailFile), 'the crash tail written');
    expect((await rawTails(tailFile)).every((t) => t.provisional === true)).toBe(true);
    return { rr, pubkey, tailFile };
  }

  /** The tail file as written (`TailBook.open` would turn a provisional entry into a tail). */
  const rawTails = async (tailFile: string) =>
    existsSync(tailFile)
      ? (
          JSON.parse(await readFile(tailFile, 'utf8')) as {
            tails: { sid: string; provisional?: true }[];
          }
        ).tails
      : [];

  /** The tails on disk (read on the rig's clock: the host's tails expire on it). */
  const bookOf = async (tailFile: string, pubkey: NostrPubkey) => {
    const doc = JSON.parse(await readFile(tailFile, 'utf8')) as {
      tails: { expiresAt: number }[];
    };
    const at = Math.min(...doc.tails.map((t) => t.expiresAt)) - TAIL_TTL_MS;
    return TailBook.open({
      dir: join(tailFile, '..'),
      pubkey,
      log: memoryLogger('warn'),
      now: () => at,
    });
  };

  it('a session the quit closed with an unpaid tail: its authorisation is on disk when shutdown resolves', async () => {
    const { rr, pubkey, tailFile } = await playing({
      handlers: { 'play.close': () => Promise.resolve({ unpaid: 2 }) },
    });
    const [session] = rr.host.adapter.sessions.all();
    await rr.host.shutdown(5000);
    // Checked synchronously: a write still in flight has not renamed its file into place yet.
    expect(existsSync(tailFile)).toBe(true);
    // The quit's tail replaced the crash tail (R2): an ordinary one.
    expect(
      (await rawTails(tailFile)).find((t) => t.sid === session!.sid)?.provisional,
    ).toBeUndefined();
    const book = await bookOf(tailFile, pubkey);
    expect(book.size()).toBe(1);
    expect(book.get(session!.sid)).toMatchObject({ budgetBlocks: 2, paidBlocks: 0 });
  }, 30_000);

  it('a session the quit could not close in time: the plane keeps all it had left, on disk when shutdown resolves', async () => {
    const { rr, pubkey, tailFile } = await playing({
      // The worker never answers play.close: the quit's bound runs out with the session open.
      handlers: { 'play.close': () => new Promise<never>(() => undefined) },
    });
    const [session] = rr.host.adapter.sessions.all();
    await rr.host.shutdown(50);
    expect(existsSync(tailFile)).toBe(true);
    expect(
      (await rawTails(tailFile)).find((t) => t.sid === session!.sid)?.provisional,
    ).toBeUndefined();
    const book = await bookOf(tailFile, pubkey);
    expect(book.get(session!.sid)?.budgetBlocks).toBeGreaterThan(0);
    expect(book.get(session!.sid)?.budgetBlocks).toBeLessThanOrEqual(MAX_TAIL_BLOCKS);
  }, 30_000);
});

// Fix round 7 (lane P2-owed-viewer, the verifier's residual of finding 5): sign out, then sign in
// again at once, while a tail's PAY waits for its turn at the mint behind a PAY whose swap is slow.
// At that turn the closed plane refused the PAY and gave its blocks back by saving its OWN tail
// book — after the next plane had read the file and saved a tail of its own, which the late write
// erased from disk. The closed plane's book is fenced at the close; this is the production path
// (the signer flow's sign-out and connect, the worker restarted around each plane change).
describe('sign out, then sign in at once, with a tail PAY waiting at the mint (ADR 0018 amendment)', () => {
  it('the closed plane writes nothing over the next plane’s tails when that PAY’s turn comes', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x47) });
    const held: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    type RequestFn = mocks.TestMint['request'];
    const request: RequestFn = <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
      const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
      if (!held.hold || path !== 'POST /v1/swap') return mint.request<T>(args);
      held.hold = false;
      return new Promise<T>((resolve, reject) => {
        held.release = () => {
          mint.request<T>(args).then(resolve, reject);
        };
      });
    };
    const asked: PromptForm[] = [];
    const rr = await rig({
      mintRequest: () => request,
      signerCost: signerMod.minimumCost(),
      onOut: answering((f) => {
        if (f.kind === 'local-setup')
          return {
            kind: 'local-setup',
            method: 'passphrase',
            flow: f.hasKey ? 'unlock' : 'generate',
          };
        if (f.kind === 'new-passphrase' || f.kind === 'unlock-passphrase')
          return { kind: 'secret', value: new TextEncoder().encode(PASS) };
        return null;
      }, asked),
    });
    r = rr;
    await rr.host.adapter.updateSettings({ defaultMints: [MINT] });
    await rr.ready();
    const connected = await invoke(rr, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(connected.ok).toBe(true);
    const pubkey = connected.ok ? (connected.result as { pubkey: string }).pubkey : '';
    const flow = rr.host.signerFlow!;
    const plane = flow.money()!;
    const q = await rr.host.adapter.wallet.mintQuote(MINT, 200 as Sats);
    mint.payQuote(q.quoteId);
    await rr.host.adapter.wallet.pollQuote(q);

    const core = 'c0'.repeat(32) as CoreKeyHex;
    const blob: HyperblobId = { blockOffset: 10, blockLength: 4, byteOffset: 0, byteLength: 4096 };
    const p2pk = (fill: number) =>
      Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
        'hex',
      ) as CashuP2pkPubkey;
    const policy: PricePolicy = {
      satsPerBlock: 2 as Sats,
      blockSize: 1024,
      mints: [MINT],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: p2pk(0x48),
    };
    const creator = 'c1'.repeat(32) as NostrPubkey;
    const seeder = { pubkey: 'd1'.repeat(32) as NostrPubkey, p2pk: p2pk(0x49), mint: MINT };
    const tailSid = 'ab'.repeat(16) as SessionId;
    const openSid = 'cd'.repeat(16) as SessionId;
    const nextSid = 'ef'.repeat(16) as SessionId;
    const build = (sid: SessionId, fromBlock: number, toBlock: number) => ({
      sid,
      range: { core, fromBlock, toBlock },
      seeder,
      policy,
      carryIn: 0,
    });
    const code = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'resolved',
        (e: unknown) => String((e as { code?: unknown }).code),
      );
    const tailFile = join(rr.userData, TAIL_DIR, `${pubkey}.json`);
    const onDisk = async () =>
      (
        JSON.parse(await readFile(tailFile, 'utf8')) as {
          tails: { sid: string; paidBlocks: number }[];
        }
      ).tails;

    // A session closed with 2 blocks unpaid leaves a tail; another is open.
    plane.authorizeSession(tailSid, { core, blob, policy }, creator);
    await plane.revokeSession(tailSid, 2);
    plane.authorizeSession(openSid, { core, blob, policy }, creator);
    // The open session's PAY holds the mint's turn (its swap held at the mint)…
    const h = plane.handlers();
    held.hold = true;
    const first = code(h['pay.build']!(build(openSid, 10, 11)));
    await eventually(() => held.release !== null, 'the first PAY at the mint', 10_000);
    // …the tail's PAY takes its block off the budget on disk, then waits for its turn.
    const second = code(h['pay.build']!(build(tailSid, 10, 10)));
    for (let i = 0; i < 500; i++) {
      if ((await onDisk()).find((t) => t.sid === tailSid)?.paidBlocks === 1) break;
      await new Promise((res) => setTimeout(res, 2));
    }
    await new Promise((res) => setTimeout(res, 20));

    // Sign out, then sign in again at once (the key file stays: the prompt unlocks it).
    const out = await invoke(rr, 'desktop.signer.signOut', []);
    expect(out.ok).toBe(true);
    expect(flow.money()).toBeUndefined();
    const again = await invoke(rr, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(again.ok).toBe(true);
    expect(asked.filter((f) => f.kind === 'local-setup').at(-1)).toMatchObject({ hasKey: true });
    const next = flow.money();
    expect(next).toBeDefined();
    expect(next).not.toBe(plane);
    expect(next!.pubkey).toBe(pubkey);
    // The next plane read the file after the closed one's writes landed; it saves a tail too.
    next!.authorizeSession(nextSid, { core, blob, policy }, creator);
    await next!.revokeSession(nextSid, 2);
    const sids = [tailSid, openSid, nextSid].sort();
    expect((await onDisk()).map((t) => t.sid).sort()).toEqual(sids);

    // The waiting PAY's turn comes: the closed plane refuses it and writes nothing.
    held.release!();
    expect(await second).toBe('payments-unavailable');
    await first;
    await plane.flushTails();
    await rr.host.adapter.flushTails();
    const after = await onDisk();
    expect(after.map((t) => t.sid).sort()).toEqual(sids);
    // What the refused PAY would have given back stays taken: the conservative side.
    expect(after.find((t) => t.sid === tailSid)?.paidBlocks).toBe(1);
  }, 60_000);
});
