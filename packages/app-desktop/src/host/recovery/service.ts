/**
 * The desktop's NUT-13 recovery phrase (ADR 0016, issue #3): one phrase per device, sealed here
 * and copied to the user's relays NIP-44-encrypted to self; the balance held before it reissued
 * once into seeded outputs, the fee shown first; a restore scans every phrase the identity can
 * reach. Core's phrase, seed and restore code (lane N1) is taken by injection (`./core.ts`).
 *
 * Flows (each started by the renderer naming an ACTION, throttled like the signer's connect —
 * a page that keeps re-opening dismissed prompts is paused — and one at a time):
 *
 *   setup    no phrase yet: generate → show it in main's prompt window (`recovery-show`, word
 *            INDICES) → nothing is kept unless the user answers "I wrote them down" or "Later"
 *            (a closed window discards it) → seal it (NIP-44 to self) + publish the relay copy →
 *            confirm three random words (`recovery-confirm`; "Later" leaves it unconfirmed) →
 *            reopen the money plane, which now derives from it → plan the reissue per mint →
 *            main's NATIVE dialog shows amounts and fees → reissue.
 *            A phrase whose reissue did not finish: only the reissue runs again.
 *            A finished phrase: rotation — re-authenticate first, then as above; the old phrase
 *            is kept on this device as `.retired` (restore reads it) and its relay copy retired
 *            once the reissue under the new one completed.
 *   show     re-authenticate (the local key's passphrase in the prompt window; a native confirm
 *            for a remote signer), then show the words again; an unconfirmed backup may be
 *            confirmed then.
 *   restore  requires this device's own phrase (the seam's restore lives on the seeded wallet,
 *            docs/contract-requests/N2-nut13-desktop.md item 2); an optional typed phrase
 *            (`recovery-restore`, checksum re-checked here by core), this device's phrases
 *            (current and retired) and every relay copy the identity decrypts — read ONLY here —
 *            each scanned from counter 0 at the wallet's mints, with progress, and one report
 *            row per mint.
 *
 * Secrets: the entropy exists as bytes (zeroed after use), inside the NIP-44 plaintext (a JS
 * string, which cannot be wiped: ADR 0016 §2 residual) and as word indices in the prompt form
 * and answer (numbers, zeroed as far as JS allows). No word, index or entropy is ever logged,
 * returned to the renderer or put in an error: errors are codes and fixed sentences.
 */
import { randomBytes, randomInt } from 'node:crypto';

import type { MintUrl, NostrPubkey, Sats, Signer, UnixSeconds } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';
import { signer as signerMod } from '@sovit/core';

import { IpcError } from '../../ipc/errors.js';
import { isConfirmForm } from '../../ipc/guards.js';
import type {
  ConfirmForm,
  RecoveryProgressWire,
  RecoveryRestoreWire,
  RecoverySetupWire,
  RecoveryStatusWire,
  RestoreOutcomeWire,
} from '../../ipc/protocol.js';
import { MAX_REISSUE_PLANS, RECOVERY_CONFIRM_WORDS, RECOVERY_WORDS } from '../../ipc/protocol.js';
import { fail, hostError } from '../errors.js';
import type { Logger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import type { MainBridge } from '../signer/main-bridge.js';
import { wipeAnswer } from '../signer/main-bridge.js';
import {
  CANCEL_COOLDOWN_MS,
  CANCEL_LIMIT,
  CANCEL_WINDOW_MS,
  UNLOCK_ATTEMPTS,
} from '../signer/desktop-signer.js';
import type { RecoveryCore } from './core.js';
import { entropyFromHex, entropyHex, uniqueMints } from './core.js';
import type { RecoveryEnvelope } from './files.js';
import {
  FileCounterStore,
  listRetired,
  readEnvelope,
  recoveryPath,
  retireCounters,
  retiredPath,
  writeEnvelope,
} from './files.js';
import type { RecoveryRelays } from './relay-copy.js';
import {
  parseRelayCopy,
  publishRelayCopy,
  readRelayCopies,
  retireRelayCopy,
} from './relay-copy.js';

/** Tries at the three-word confirmation before it counts as "not confirmed". */
export const CONFIRM_ATTEMPTS = 3;

export interface RecoveryServiceOptions {
  /** Lane N1's code (the wiring point), or `undefined`: no phrase on this build. */
  readonly core: RecoveryCore | undefined;
  /** `<userData>/wallet` (0700). */
  readonly dir: string;
  readonly bridge: MainBridge;
  /** The unlocked signer (`undefined` while signed out or locked). */
  readonly signer: () => Signer | undefined;
  /** That signer's money plane, if its wallet opened. */
  readonly plane: () => MoneyPlane | undefined;
  /**
   * Close the money plane, run `beforeOpen` (no plane holds the wallet then), open it again — it
   * then derives from the phrase `beforeOpen` saved (`DesktopSigner.reopenMoney`).
   */
  readonly reopenMoney: (beforeOpen?: () => Promise<void>) => Promise<void>;
  /** Re-authentication of a local key: does `passphrase` open `pubkey`'s key file? */
  readonly checkPassphrase: (passphrase: Uint8Array, pubkey: NostrPubkey) => Promise<boolean>;
  readonly relays: RecoveryRelays;
  readonly log: Logger;
  readonly now?: () => UnixSeconds;
  /** The throttle's clock (ms). */
  readonly clock?: () => number;
  /** Tests: randomness for device ids and confirmation positions (default `node:crypto`). */
  readonly random?: { readonly bytes: (n: number) => Uint8Array; readonly int: (max: number) => number };
}

/** What the money plane opens with when this device has a phrase (`seedFor`). */
export interface PlaneSeed {
  readonly material: walletMod.SeedMaterial;
  readonly core: Pick<RecoveryCore, 'connections' | 'seeded'>;
}

const UNAVAILABLE: RecoveryStatusWire = {
  state: 'unavailable',
  reissuePending: false,
  relayCopy: false,
};

/** Outcome precedence when several phrases report on one mint. */
const RANK: Readonly<Record<RestoreOutcomeWire, number>> = {
  nothing: 0,
  unsupported: 1,
  unreachable: 2,
  refused: 3,
  restored: 4,
};

/** The code prefix of an error (`recovery-unreadable`, `rate-limited`, …) — never its detail. */
function prefix(e: unknown): string {
  if (e instanceof IpcError) return e.code;
  const m = e instanceof Error ? e.message : '';
  return /^[a-z][a-z0-9-]*(?=:)/.exec(m)?.[0] ?? (e instanceof Error ? e.name : 'unknown');
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** A seam `RecoveryPhraseError`'s problem (`length` / `word` / `checksum`), never a word. */
function problemOf(e: unknown): string {
  const p = (e as { problem?: unknown } | null)?.problem;
  return p === 'length' || p === 'word' || p === 'checksum' ? p : 'invalid';
}

export class RecoveryService {
  private readonly o: RecoveryServiceOptions;
  private readonly log: Logger;
  private readonly now: () => UnixSeconds;
  private readonly clock: () => number;
  private readonly random: NonNullable<RecoveryServiceOptions['random']>;
  /** Identities whose phrase file is here but did not open when their plane did. */
  private readonly unreadable = new Set<NostrPubkey>();
  private readonly progress = new Set<(p: RecoveryProgressWire) => void>();
  private busy = false;
  private cancels: number[] = [];
  private coolUntil = 0;

  constructor(o: RecoveryServiceOptions) {
    this.o = o;
    this.log = o.log.child('recovery');
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.clock = o.clock ?? Date.now;
    this.random = o.random ?? {
      bytes: (n) => new Uint8Array(randomBytes(n)),
      int: (max) => randomInt(max),
    };
  }

  // ---- the money plane's seed ------------------------------------------------------------

  /**
   * Called before a money plane opens for `pubkey`: this device's phrase as seed material (the
   * seed in core's secure memory, the counters file), or `undefined` — no phrase support, no
   * phrase, or a phrase file that does not open (then the wallet derives nothing from it, the
   * status says `unreadable`, the file is kept, and setup refuses to replace it).
   */
  async seedFor(signer: Signer, pubkey: NostrPubkey): Promise<PlaneSeed | undefined> {
    this.unreadable.delete(pubkey);
    const core = this.o.core;
    if (core === undefined) return undefined;
    let entropy: walletMod.RecoveryEntropy | undefined;
    try {
      const env = await readEnvelope(recoveryPath(this.o.dir, pubkey));
      if (env === null) return undefined;
      entropy = await this.unseal(signer, pubkey, env);
      const seed = await core.phrases.toSeed(entropy);
      return {
        material: { seed, counters: new FileCounterStore(this.o.dir, pubkey) },
        core,
      };
    } catch (e) {
      this.unreadable.add(pubkey);
      this.log.error(
        'the recovery phrase on this device did not open: new ecash is not covered, and the file is kept',
        { reason: prefix(e) },
      );
      return undefined;
    } finally {
      entropy?.fill(0);
    }
  }

  // ---- the renderer's calls --------------------------------------------------------------

  async status(): Promise<RecoveryStatusWire> {
    const core = this.o.core;
    const plane = this.o.plane();
    if (core === undefined || plane === undefined || this.o.signer() === undefined)
      return UNAVAILABLE;
    let env: RecoveryEnvelope | null;
    try {
      env = await readEnvelope(recoveryPath(this.o.dir, plane.pubkey));
    } catch {
      return { state: 'unreadable', reissuePending: false, relayCopy: false };
    }
    if (env === null) return { state: 'not-on-device', reissuePending: false, relayCopy: false };
    const inUse = !this.unreadable.has(plane.pubkey) && core.seeded(plane.wallet) !== undefined;
    return {
      state: !inUse ? 'unreadable' : env.confirmed ? 'covered' : 'not-confirmed',
      reissuePending: !env.reissued,
      relayCopy: env.relayCopy,
    };
  }

  /** New phrase, finish its reissue, or rotate (see the module comment). */
  setup(): Promise<RecoverySetupWire> {
    return this.throttled(() => this.exclusive(() => this.setupNow()));
  }

  /** Show this device's phrase again, after re-authentication. */
  show(): Promise<undefined> {
    return this.throttled(() => this.exclusive(() => this.showNow()));
  }

  /** Scan every phrase the identity reaches and add what is unspent and not held. */
  restore(): Promise<RecoveryRestoreWire> {
    return this.throttled(() => this.exclusive(() => this.restoreNow()));
  }

  /** Topic `recovery.progress`. */
  onProgress(cb: (p: RecoveryProgressWire) => void): () => void {
    this.progress.add(cb);
    return () => {
      this.progress.delete(cb);
    };
  }

  // ---- flows -----------------------------------------------------------------------------

  private ready(): {
    core: RecoveryCore;
    signer: Signer;
    plane: MoneyPlane;
    pubkey: NostrPubkey;
  } {
    const core = this.o.core;
    if (core === undefined)
      fail('payments-unavailable', 'this build of Nutflix has no recovery phrase support yet');
    const signer = this.o.signer();
    const plane = this.o.plane();
    if (signer === undefined || plane === undefined)
      fail('payments-unavailable', 'connect and unlock a signer with a wallet first');
    return { core, signer, plane, pubkey: plane.pubkey };
  }

  /** This identity's envelope; a file that does not open is `forbidden` (kept, never replaced). */
  private async envelope(pubkey: NostrPubkey): Promise<RecoveryEnvelope | null> {
    try {
      return await readEnvelope(recoveryPath(this.o.dir, pubkey));
    } catch {
      fail(
        'forbidden',
        'the recovery phrase file on this device cannot be read: it is kept and not replaced (see the log)',
      );
    }
  }

  private async setupNow(): Promise<RecoverySetupWire> {
    const { core, signer, pubkey } = this.ready();
    const path = recoveryPath(this.o.dir, pubkey);
    const old = await this.envelope(pubkey);
    if (this.unreadable.has(pubkey))
      fail(
        'forbidden',
        'the recovery phrase on this device did not open: it is kept and not replaced (see the log)',
      );
    // A phrase whose reissue did not finish: finish it (nothing is revealed or replaced).
    if (old !== null && !old.reissued) return await this.finishReissue(pubkey, old, null);
    // Rotation replaces a working phrase: the user proves it is them first.
    if (old !== null) await this.reauth(signer, pubkey);

    const entropy = core.phrases.generate();
    let words: number[] = [];
    let env: RecoveryEnvelope | undefined;
    try {
      words = [...core.phrases.toIndices(entropy)];
      if (words.length !== RECOVERY_WORDS) fail('internal', 'the phrase has the wrong length');
      const shown = await this.o.bridge.ask({
        kind: 'recovery-show',
        words: [...words],
        again: false,
      });
      if (shown?.kind !== 'recovery-show')
        fail('cancelled', 'the new recovery phrase was discarded (nothing was saved)');
      // From here the phrase is kept: sealed on this device, copied to the relays.
      const created = this.now();
      const sealed = await signer.nip44Encrypt(
        pubkey,
        JSON.stringify({ v: 1, entropy: entropyHex(entropy), created }),
      );
      const fresh: RecoveryEnvelope = {
        v: 1,
        device: hex(this.random.bytes(16)),
        created,
        confirmed: false,
        reissued: false,
        relayCopy: false,
        sealed,
      };
      // Saved while no money plane holds the wallet: a replaced phrase is retired (restore still
      // reads it), and so is any counters file — the new phrase derives from counter 0. The
      // plane that opens next derives from the new phrase.
      await this.o.reopenMoney(async () => {
        if (old !== null)
          await writeEnvelope(this.o.dir, retiredPath(this.o.dir, pubkey, old.device), old);
        await retireCounters(this.o.dir, pubkey, old?.device ?? hex(this.random.bytes(16)));
        await writeEnvelope(this.o.dir, path, fresh);
        env = fresh;
      });
      const saved = await readEnvelope(path).catch(() => null);
      if (env === undefined || saved?.device !== fresh.device)
        fail('internal', 'the recovery phrase could not be saved (nothing was changed)');
      this.log.info(old === null ? 'recovery phrase saved on this device' : 'recovery phrase replaced');
      const published = await publishRelayCopy({
        signer,
        relays: this.o.relays,
        device: fresh.device,
        sealed: fresh.sealed,
        now: this.now,
      }).catch(() => false);
      let cur = fresh;
      if (published) {
        cur = { ...cur, relayCopy: true };
        await writeEnvelope(this.o.dir, path, cur);
      } else
        this.log.warn('the recovery phrase copy reached no relay: it is sealed on this device only');
      if (shown.done && (await this.confirmWords(words))) {
        cur = { ...cur, confirmed: true };
        await writeEnvelope(this.o.dir, path, cur);
      }
      env = cur;
    } finally {
      entropy.fill(0);
      words.fill(0);
    }
    return await this.finishReissue(pubkey, env, old);
  }

  /** D5: move the balance under the phrase (native confirm with the fees); record the outcome. */
  private async finishReissue(
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
    rotatedFrom: RecoveryEnvelope | null,
  ): Promise<RecoverySetupWire> {
    // A plane that is not deriving from the phrase yet (its reopen failed, or never ran) opens
    // again first: the reissue must land in seeded outputs.
    const core = this.o.core;
    const plane = this.o.plane();
    if (core !== undefined && plane !== undefined && core.seeded(plane.wallet) === undefined)
      await this.o.reopenMoney().catch((e: unknown) => {
        this.log.warn('the wallet did not reopen with the recovery phrase', { reason: prefix(e) });
      });
    const r = await this.reissueAll(pubkey);
    let cur = env;
    if (r.complete) {
      cur = { ...env, reissued: true };
      await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), cur);
      const signer = this.o.signer();
      if (rotatedFrom !== null && signer !== undefined) {
        const retired = await retireRelayCopy({
          signer,
          pubkey,
          relays: this.o.relays,
          device: rotatedFrom.device,
          now: this.now,
        });
        if (!retired) this.log.warn('the replaced phrase’s relay copy may still be on a relay');
      }
    }
    return {
      status: await this.status(),
      reissuedSats: r.sats as Sats,
      feeSats: r.fee as Sats,
      reissueFailed: r.failed,
    };
  }

  private async reissueAll(pubkey: NostrPubkey): Promise<{
    sats: number;
    fee: number;
    failed: number;
    complete: boolean;
  }> {
    const core = this.o.core;
    const plane = this.o.plane();
    const seeded =
      core === undefined || plane?.pubkey !== pubkey ? undefined : core.seeded(plane.wallet);
    if (plane === undefined || seeded === undefined) {
      this.log.warn('the wallet is not using the recovery phrase yet: nothing was reissued');
      return { sats: 0, fee: 0, failed: 0, complete: false };
    }
    let failed = 0;
    const plans: walletMod.ReissuePlan[] = [];
    let balances: ReadonlyMap<MintUrl, Sats>;
    try {
      balances = await plane.wallet.balances();
    } catch (e) {
      this.log.warn('the balances could not be read: nothing was reissued', { reason: prefix(e) });
      return { sats: 0, fee: 0, failed: 0, complete: false };
    }
    for (const [mint, amount] of balances) {
      if (amount <= 0) continue;
      try {
        const p = await seeded.reissuePlan(mint);
        // Dust whose fee would eat it all stays as it is (nothing sensible to move).
        if (p.amount > 0 && p.feeSats < p.amount) plans.push(p);
      } catch (e) {
        failed++;
        this.log.warn('no reissue plan at a mint', { reason: prefix(e) });
      }
    }
    const asked = plans.slice(0, MAX_REISSUE_PLANS);
    failed += plans.length - asked.length;
    if (asked.length === 0) return { sats: 0, fee: 0, failed, complete: failed === 0 };
    const ok = await this.confirm({
      kind: 'recovery-reissue',
      plans: asked.map((p) => ({
        mint: p.mint,
        amount: p.amount,
        inputs: p.inputs,
        feeSats: p.feeSats,
      })),
    });
    if (!ok) {
      this.log.info('the user did not confirm the reissue: the balance stays uncovered for now');
      return { sats: 0, fee: 0, failed: failed + asked.length, complete: false };
    }
    let sats = 0;
    let fee = 0;
    for (const p of asked) {
      try {
        const done = await seeded.reissue(p);
        sats += done.reissued;
        fee += done.feeSats;
      } catch (e) {
        failed++;
        this.log.warn('the reissue failed at a mint (its balance stays uncovered)', {
          reason: prefix(e),
        });
      }
    }
    this.log.info('balance reissued under the recovery phrase', { mints: asked.length, failed });
    return { sats, fee, failed, complete: failed === 0 };
  }

  private async showNow(): Promise<undefined> {
    const { core, signer, pubkey } = this.ready();
    const env = await this.envelope(pubkey);
    if (env === null) fail('not-found', 'there is no recovery phrase on this device');
    await this.reauth(signer, pubkey);
    let words: number[] = [];
    let entropy: walletMod.RecoveryEntropy | undefined;
    try {
      try {
        entropy = await this.unseal(signer, pubkey, env);
      } catch {
        fail('forbidden', 'the recovery phrase file on this device cannot be read (see the log)');
      }
      words = [...core.phrases.toIndices(entropy)];
      entropy.fill(0);
      const a = await this.o.bridge.ask({ kind: 'recovery-show', words: [...words], again: true });
      if (a?.kind === 'recovery-show' && a.done && !env.confirmed && (await this.confirmWords(words)))
        await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), {
          ...env,
          confirmed: true,
        });
      return undefined;
    } finally {
      entropy?.fill(0);
      words.fill(0);
    }
  }

  private async restoreNow(): Promise<RecoveryRestoreWire> {
    const { core, signer, plane, pubkey } = this.ready();
    const seeded = core.seeded(plane.wallet);
    if (seeded === undefined)
      fail(
        'invalid-argument',
        'set up this device’s recovery phrase first: a restore runs through the wallet it seeds',
      );
    const a = await this.o.bridge.ask({ kind: 'recovery-restore' });
    if (a?.kind !== 'recovery-restore') fail('cancelled', 'the restore was not started');
    const found = new Map<string, walletMod.RecoveryEntropy>();
    const add = (e: walletMod.RecoveryEntropy): void => {
      const k = entropyHex(e);
      if (found.has(k)) e.fill(0);
      else found.set(k, e);
    };
    try {
      if (a.words.length > 0) {
        let typed: walletMod.RecoveryEntropy;
        try {
          typed = core.phrases.fromIndices(a.words);
        } catch (e) {
          fail('invalid-argument', `the typed words are not a recovery phrase (${problemOf(e)})`);
        } finally {
          (a.words as number[]).fill(0);
        }
        add(typed);
      }
      let localUnreadable = 0;
      const paths = [
        recoveryPath(this.o.dir, pubkey),
        ...(await listRetired(this.o.dir, pubkey).catch(() => [])),
      ];
      for (const p of paths) {
        try {
          const env = await readEnvelope(p);
          if (env !== null) add(await this.unseal(signer, pubkey, env));
        } catch {
          localUnreadable++;
        }
      }
      let relayUnreadable = 0;
      try {
        const r = await readRelayCopies({ signer, pubkey, relays: this.o.relays });
        relayUnreadable = r.unreadable;
        for (const c of r.copies) add(entropyFromHex(c.entropy));
      } catch (e) {
        this.log.warn('the relay copies could not be read', { reason: prefix(e) });
      }
      const mints = uniqueMints(plane.mints);
      const phrases = found.size;
      this.log.info('restoring from recovery phrases', {
        phrases,
        mints: mints.length,
        localUnreadable,
        relayUnreadable,
      });
      const rows = new Map<MintUrl, { outcome: RestoreOutcomeWire; restoredSats: number }>();
      for (const m of mints) rows.set(m, { outcome: 'nothing', restoredSats: 0 });
      let i = 0;
      for (const entropy of found.values()) {
        i++;
        const phrase = i;
        const seed = await core.phrases.toSeed(entropy);
        entropy.fill(0);
        try {
          const reports = await seeded.restoreFromSeed(seed, mints, (p) => {
            this.emit({
              phrase,
              phrases,
              mint: p.mint,
              keysetsDone: p.keysetsDone,
              keysets: p.keysets,
            });
          });
          for (const r of reports) {
            const row = rows.get(r.mint);
            if (row === undefined) continue;
            row.restoredSats += r.restoredSats;
            if (RANK[r.outcome] > RANK[row.outcome]) row.outcome = r.outcome;
          }
        } catch (e) {
          this.log.warn('a restore pass failed', { reason: prefix(e) });
          for (const row of rows.values())
            if (RANK[row.outcome] < RANK.unreachable) row.outcome = 'unreachable';
        } finally {
          seed.wipe();
        }
      }
      const reports = [...rows].map(([mint, r]) => ({
        mint,
        outcome: r.outcome,
        restoredSats: r.restoredSats as Sats,
      }));
      this.log.info('restore finished', {
        phrases,
        restoredMints: reports.filter((r) => r.outcome === 'restored').length,
      });
      return { phrases, reports };
    } finally {
      for (const e of found.values()) e.fill(0);
    }
  }

  // ---- helpers ---------------------------------------------------------------------------

  /** The envelope's entropy, through the signer (NIP-44 to self). */
  private async unseal(
    signer: Signer,
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
  ): Promise<walletMod.RecoveryEntropy> {
    let text: string;
    try {
      text = await signer.nip44Decrypt(pubkey, env.sealed);
    } catch {
      throw new Error('recovery-unreadable: the phrase does not decrypt with this identity');
    }
    const copy = parseRelayCopy(text);
    if (copy === null) throw new Error('recovery-unreadable: the phrase file is damaged');
    return entropyFromHex(copy.entropy);
  }

  /**
   * Before the phrase is revealed or replaced: the local key's passphrase (`UNLOCK_ATTEMPTS`
   * tries, checked against the key file), or main's native confirm for a remote signer.
   */
  private async reauth(signer: Signer, pubkey: NostrPubkey): Promise<void> {
    if (signer.kind === 'local') {
      for (let attempt = 1; attempt <= UNLOCK_ATTEMPTS; attempt++) {
        const a = await this.o.bridge.ask({ kind: 'recovery-reauth', retry: attempt > 1 });
        if (a?.kind !== 'secret') {
          wipeAnswer(a);
          fail('cancelled', 'the passphrase was not given');
        }
        let ok = false;
        try {
          ok = await this.o.checkPassphrase(a.value, pubkey);
        } catch {
          ok = false;
        } finally {
          signerMod.wipe(a.value);
        }
        if (ok) return;
      }
      fail('forbidden', 'wrong passphrase');
    }
    if (!(await this.confirm({ kind: 'recovery-reveal' })))
      fail('cancelled', 'showing the recovery phrase was not confirmed');
  }

  /** Three random positions; `true` when the words typed there match (a few tries). */
  private async confirmWords(words: readonly number[]): Promise<boolean> {
    const pool = Array.from({ length: RECOVERY_WORDS }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = this.random.int(i + 1);
      [pool[i], pool[j]] = [pool[j] ?? 0, pool[i] ?? 0];
    }
    const positions = pool.slice(0, RECOVERY_CONFIRM_WORDS).sort((a, b) => a - b);
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      const a = await this.o.bridge.ask({ kind: 'recovery-confirm', positions, retry: attempt > 1 });
      if (a?.kind !== 'recovery-confirm') return false;
      const ok =
        a.words.length === positions.length && positions.every((p, k) => a.words[k] === words[p]);
      (a.words as number[]).fill(0);
      if (ok) {
        this.log.info('recovery phrase backup confirmed');
        return true;
      }
    }
    this.log.info('recovery phrase backup not confirmed (the words did not match)');
    return false;
  }

  /** Main's native dialog, for a form checked like main will check it (never a silent drop). */
  private confirm(form: ConfirmForm): Promise<boolean> {
    if (!isConfirmForm(form)) {
      this.log.warn('a confirm question did not pass the IPC guard: not asked');
      return Promise.resolve(false);
    }
    return this.o.bridge.confirm(form);
  }

  private emit(p: RecoveryProgressWire): void {
    for (const cb of this.progress) {
      try {
        cb(p);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /** A renderer-started flow: refused while cooling down; a dismissed prompt counts. */
  private async throttled<T>(f: () => Promise<T>): Promise<T> {
    if (this.clock() < this.coolUntil)
      fail('rate-limited', 'too many dismissed prompts: try again in a minute');
    try {
      return await f();
    } catch (e) {
      if (e instanceof IpcError && e.code === 'cancelled') {
        const t = this.clock();
        this.cancels = [...this.cancels.filter((c) => t - c < CANCEL_WINDOW_MS), t];
        if (this.cancels.length >= CANCEL_LIMIT) {
          this.coolUntil = t + CANCEL_COOLDOWN_MS;
          this.cancels = [];
          this.log.warn('recovery prompts dismissed repeatedly: paused for a minute');
        }
      }
      throw e;
    }
  }

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.busy) throw hostError('rate-limited', 'a recovery phrase window is already open');
    this.busy = true;
    try {
      return await f();
    } finally {
      this.busy = false;
    }
  }
}
