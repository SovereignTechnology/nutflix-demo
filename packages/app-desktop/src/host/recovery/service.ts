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
 *            (a closed window discards it) → seal it (NIP-44 to self) while no money plane holds
 *            the wallet, and reopen the plane, which now derives from it → publish the relay
 *            copy → confirm three random words (`recovery-confirm`; "Later" leaves it
 *            unconfirmed) → plan the reissue per mint → main's NATIVE dialog shows amounts and
 *            fees → reissue.
 *            A phrase whose reissue did not finish: only the reissue runs again.
 *            A finished phrase: rotation — re-authenticate first, then as above; the old phrase
 *            is kept on this device as `.retired` (restore reads it) and its relay copy retired
 *            once the reissue under the new one completed (`replaces`, kept until then).
 *   show     re-authenticate (the local key's passphrase in the prompt window; a native confirm
 *            for a remote signer), then show the words again; an unconfirmed backup may be
 *            confirmed then.
 *   restore  requires this device's own phrase in use (the seam's restore lives on the seeded
 *            wallet, docs/contract-requests/N2-nut13-desktop.md item 2); an optional typed phrase
 *            (`recovery-restore`, checksum re-checked here by core), this device's phrases
 *            (current and retired) and every relay copy the identity decrypts — read ONLY here —
 *            each scanned from counter 0 at the wallet's mints, with progress, and one report
 *            row per mint.
 *
 * Secrets: the entropy exists as bytes (zeroed after use), inside the NIP-44 plaintext (a JS
 * string, which cannot be wiped: ADR 0016 §2 residual) and as word indices in the prompt form
 * and answer (numbers, zeroed as far as JS allows). No word, index or entropy is ever logged,
 * returned to the renderer or put in an error: the renderer gets states, counts, amounts and its
 * own mint URLs; errors are codes and fixed sentences (anything else becomes `internal`), and
 * log fields are allow-listed reason codes.
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
import {
  ERROR_CODES,
  MAX_REISSUE_PLANS,
  RECOVERY_CONFIRM_WORDS,
  RECOVERY_WORDS,
} from '../../ipc/protocol.js';
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
import { entropyFromHex, entropyHex, sameEntropy, uniqueMints } from './core.js';
import type { RecoveryEnvelope } from './files.js';
import {
  FileCounterStore,
  listRetired,
  readEnvelope,
  recoveryPath,
  retireCounters,
  retiredPath,
  unretireCounters,
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
   * then derives from the phrase `beforeOpen` saved (`DesktopSigner.reopenMoney`). A failure of
   * `beforeOpen` is rethrown once the plane is open again.
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
  readonly random?: {
    readonly bytes: (n: number) => Uint8Array;
    readonly int: (max: number) => number;
  };
}

/** What the money plane opens with when this device has a phrase (`seedFor`). */
export interface PlaneSeed {
  readonly material: walletMod.SeedMaterial;
  readonly core: Pick<RecoveryCore, 'seedOption' | 'seeded'>;
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

/** Reason codes a log line may carry (allow-list: anything else is logged as `error`). */
const REASONS: ReadonlySet<string> = new Set<string>([
  ...ERROR_CODES,
  'recovery-unreadable',
  'counters-unreadable',
  'journal-unreadable',
  'no-wallet',
]);

/** The allow-listed code of an error — never its message. */
export function reasonOf(e: unknown): string {
  if (e instanceof IpcError) return e.code;
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const p = /^([a-z][a-z0-9-]{0,40}):/.exec(m)?.[1];
  if (p !== undefined && REASONS.has(p)) return p;
  const name = e instanceof Error ? e.name : '';
  return /^[A-Z][A-Za-z]{0,40}Error$/.test(name) ? name : 'error';
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
   * phrase, or a phrase file that does not open (then the wallet derives nothing from it: its
   * outputs are random, as without a phrase; the status says `unreadable`, the file is kept, and
   * setup refuses to replace it).
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
        { reason: reasonOf(e) },
      );
      return undefined;
    } finally {
      entropy?.fill(0);
    }
  }

  // ---- the renderer's calls --------------------------------------------------------------

  async status(): Promise<RecoveryStatusWire> {
    const plane = this.o.plane();
    if (this.o.core === undefined || plane === undefined || this.o.signer() === undefined)
      return UNAVAILABLE;
    let env: RecoveryEnvelope | null;
    try {
      env = await readEnvelope(recoveryPath(this.o.dir, plane.pubkey));
    } catch {
      return { state: 'unreadable', reissuePending: false, relayCopy: false };
    }
    if (env === null) return { state: 'not-on-device', reissuePending: false, relayCopy: false };
    const inUse = !this.unreadable.has(plane.pubkey) && plane.seeded !== undefined;
    return {
      state: !inUse ? 'unreadable' : env.confirmed ? 'covered' : 'not-confirmed',
      reissuePending: !env.reissued,
      relayCopy: env.relayCopy,
    };
  }

  /** New phrase, finish its reissue, or rotate (see the module comment). */
  setup(): Promise<RecoverySetupWire> {
    return this.flow(() => this.setupNow());
  }

  /** Show this device's phrase again, after re-authentication. */
  show(): Promise<undefined> {
    return this.flow(() => this.showNow());
  }

  /** Scan every phrase the identity reaches and add what is unspent and not held. */
  restore(): Promise<RecoveryRestoreWire> {
    return this.flow(() => this.restoreNow());
  }

  /** Topic `recovery.progress`. */
  onProgress(cb: (p: RecoveryProgressWire) => void): () => void {
    this.progress.add(cb);
    return () => {
      this.progress.delete(cb);
    };
  }

  // ---- flows -----------------------------------------------------------------------------

  /** Throttled, one at a time, and nothing but our own coded refusals reaches the renderer. */
  private flow<T>(f: () => Promise<T>): Promise<T> {
    return this.throttled(() => this.exclusive(() => this.guarded(f)));
  }

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
    } catch (e) {
      this.log.error('the recovery phrase file on this device cannot be read', {
        reason: reasonOf(e),
      });
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
    if (old !== null && this.unreadable.has(pubkey))
      fail(
        'forbidden',
        'the recovery phrase on this device did not open: it is kept and not replaced (see the log)',
      );
    // A phrase whose reissue did not finish: finish it (nothing is revealed or replaced).
    if (old !== null && !old.reissued) return await this.finishReissue(pubkey, old);
    // Rotation replaces a working phrase: the user proves it is them first.
    if (old !== null) await this.reauth(signer, pubkey);

    const entropy = core.phrases.generate();
    let words: number[] = [];
    /** The copy handed to main (posted as a structured clone), zeroed once answered. */
    let posted: number[] = [];
    let env: RecoveryEnvelope;
    try {
      words = [...core.phrases.toIndices(entropy)];
      if (words.length !== RECOVERY_WORDS) fail('internal', 'the phrase has the wrong length');
      posted = [...words];
      const shown = await this.o.bridge.ask({ kind: 'recovery-show', words: posted, again: false });
      posted.fill(0);
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
        // A replaced phrase's relay copy is retired once the reissue under this one completed
        // (`old` is a finished phrase here, so its own `replaces` is already null).
        replaces: old === null ? null : old.device,
        sealed,
      };
      await this.o.reopenMoney(() => this.saveNew(pubkey, old, fresh));
      const saved = await readEnvelope(path).catch(() => null);
      if (saved?.device !== fresh.device)
        fail('internal', 'the recovery phrase could not be saved (nothing was changed)');
      this.log.info(
        old === null ? 'recovery phrase saved on this device' : 'recovery phrase replaced',
      );
      env = fresh;
      const published = await publishRelayCopy({
        signer,
        relays: this.o.relays,
        device: fresh.device,
        sealed: fresh.sealed,
        now: this.now,
      }).catch(() => false);
      if (published) {
        env = { ...env, relayCopy: true };
        await writeEnvelope(this.o.dir, path, env);
      } else
        this.log.warn(
          'the recovery phrase copy reached no relay: it is sealed on this device only',
        );
      if (shown.done && (await this.confirmWords(words))) {
        env = { ...env, confirmed: true };
        await writeEnvelope(this.o.dir, path, env);
      }
    } finally {
      entropy.fill(0);
      words.fill(0);
      posted.fill(0);
    }
    return await this.finishReissue(pubkey, env);
  }

  /**
   * While no plane holds the wallet: keep a replaced phrase as `.retired` (restore still reads
   * it), move its counters aside (the new phrase derives from counter 0), then write the new
   * phrase — putting the counters back if that last write fails, so the old phrase never loses
   * them while it stays current.
   */
  private async saveNew(
    pubkey: NostrPubkey,
    old: RecoveryEnvelope | null,
    fresh: RecoveryEnvelope,
  ): Promise<void> {
    const dir = this.o.dir;
    if (old !== null) await writeEnvelope(dir, retiredPath(dir, pubkey, old.device), old);
    const tag = old?.device ?? hex(this.random.bytes(16));
    const moved = await retireCounters(dir, pubkey, tag);
    try {
      await writeEnvelope(dir, recoveryPath(dir, pubkey), fresh);
    } catch (e) {
      if (moved)
        await unretireCounters(dir, pubkey, tag).catch((u: unknown) => {
          this.log.error('the counters file could not be put back: it is kept aside', {
            reason: reasonOf(u),
          });
        });
      throw e;
    }
  }

  /** D5: move the balance under the phrase (native confirm with the fees); record the outcome. */
  private async finishReissue(
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
  ): Promise<RecoverySetupWire> {
    // A plane that is not deriving from the phrase yet (its reopen failed, or never ran) opens
    // again first: the reissue must land in seeded outputs.
    const plane = this.o.plane();
    if (plane !== undefined && plane.seeded === undefined)
      await this.o.reopenMoney().catch((e: unknown) => {
        this.log.warn('reopen with the recovery phrase failed', {
          reason: reasonOf(e),
        });
      });
    const r = await this.reissueAll(pubkey);
    if (r.complete) {
      // The replaced phrase restores nothing held any more: its relay copy goes (best effort,
      // idempotent — a crash before the write below only repeats it), then ONE write records
      // both, so a recorded reissue never leaves a copy to retire behind.
      const signer = this.o.signer();
      if (env.replaces !== null && signer !== undefined) {
        const retired = await retireRelayCopy({
          signer,
          pubkey,
          relays: this.o.relays,
          device: env.replaces,
          now: this.now,
        });
        if (!retired) this.log.warn('the replaced phrase’s relay copy may still be on a relay');
      }
      await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), {
        ...env,
        reissued: true,
        replaces: null,
      });
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
    const plane = this.o.plane();
    const seeded = plane?.pubkey === pubkey ? plane.seeded : undefined;
    if (plane === undefined || seeded === undefined) {
      this.log.warn('recovery phrase not in use by the wallet yet: nothing reissued');
      return { sats: 0, fee: 0, failed: 0, complete: false };
    }
    let failed = 0;
    const plans: walletMod.ReissuePlan[] = [];
    let balances: ReadonlyMap<MintUrl, Sats>;
    try {
      balances = await plane.wallet.balances();
    } catch (e) {
      this.log.warn('the balances could not be read: nothing was reissued', {
        reason: reasonOf(e),
      });
      return { sats: 0, fee: 0, failed: 0, complete: false };
    }
    for (const [mint, amount] of balances) {
      if (amount <= 0) continue;
      try {
        const p = await seeded.reissuePlan(mint);
        // Dust whose fee would eat it all stays as it is (nothing sensible to move).
        if (p.mint === mint && p.amount > 0 && p.feeSats < p.amount) plans.push(p);
      } catch (e) {
        failed++;
        this.log.warn('no reissue plan at a mint', { reason: reasonOf(e) });
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
      this.log.info('reissue not confirmed by the user: the balance stays uncovered for now');
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
          reason: reasonOf(e),
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
    let posted: number[] = [];
    let entropy: walletMod.RecoveryEntropy | undefined;
    try {
      try {
        entropy = await this.unseal(signer, pubkey, env);
      } catch (e) {
        this.log.error('the recovery phrase file on this device cannot be read', {
          reason: reasonOf(e),
        });
        fail('forbidden', 'the recovery phrase file on this device cannot be read (see the log)');
      }
      words = [...core.phrases.toIndices(entropy)];
      entropy.fill(0);
      if (words.length !== RECOVERY_WORDS) fail('internal', 'the phrase has the wrong length');
      posted = [...words];
      const a = await this.o.bridge.ask({ kind: 'recovery-show', words: posted, again: true });
      posted.fill(0);
      if (
        a?.kind === 'recovery-show' &&
        a.done &&
        !env.confirmed &&
        (await this.confirmWords(words))
      ) {
        // Re-read: only the confirmation changes (a concurrent write is not expected, but the
        // file is the record).
        const cur = await this.envelope(pubkey);
        if (cur?.device === env.device)
          await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), {
            ...cur,
            confirmed: true,
          });
      }
      return undefined;
    } finally {
      entropy?.fill(0);
      words.fill(0);
      posted.fill(0);
    }
  }

  private async restoreNow(): Promise<RecoveryRestoreWire> {
    const { core, signer, plane, pubkey } = this.ready();
    const seeded = plane.seeded;
    if (seeded === undefined)
      fail(
        'invalid-argument',
        'set up this device’s recovery phrase first: a restore runs through the wallet it seeds',
      );
    const a = await this.o.bridge.ask({ kind: 'recovery-restore' });
    if (a?.kind !== 'recovery-restore') fail('cancelled', 'the restore was not started');
    const found: walletMod.RecoveryEntropy[] = [];
    const add = (e: walletMod.RecoveryEntropy): void => {
      if (found.some((f) => sameEntropy(f, e))) e.fill(0);
      else found.push(e);
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
      // ADR 0016 D2: the relay copies are read HERE only — an explicit restore — never at startup.
      let relayUnreadable = 0;
      try {
        const r = await readRelayCopies({ signer, pubkey, relays: this.o.relays });
        relayUnreadable = r.unreadable;
        for (const c of r.copies) add(entropyFromHex(c.entropy));
      } catch (e) {
        this.log.warn('the relay copies could not be read', { reason: reasonOf(e) });
      }
      const listed = await plane.wallet.mints().catch((): readonly MintUrl[] => []);
      const mints = uniqueMints([...plane.mints, ...listed]);
      const phrases = found.length;
      this.log.info('restoring from recovery phrases', {
        phrases,
        mints: mints.length,
        localUnreadable,
        relayUnreadable,
      });
      const rows = new Map<MintUrl, { outcome: RestoreOutcomeWire; restoredSats: number }>();
      for (const m of mints) rows.set(m, { outcome: 'nothing', restoredSats: 0 });
      for (let i = 0; i < found.length; i++) {
        const entropy = found[i];
        if (entropy === undefined) continue;
        const phrase = i + 1;
        let seed: walletMod.RecoverySeed | undefined;
        try {
          seed = await core.phrases.toSeed(entropy);
          entropy.fill(0);
          const reports = await seeded.restoreFromSeed(seed, mints, (p) => {
            if (!rows.has(p.mint)) return;
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
            if (Number.isSafeInteger(r.restoredSats) && r.restoredSats > 0)
              row.restoredSats += r.restoredSats;
            if (RANK[r.outcome] > RANK[row.outcome]) row.outcome = r.outcome;
          }
        } catch (e) {
          this.log.warn('a restore pass failed', { pass: phrase, reason: reasonOf(e) });
          for (const row of rows.values())
            if (RANK[row.outcome] < RANK.unreachable) row.outcome = 'unreachable';
        } finally {
          entropy.fill(0);
          seed?.wipe();
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
      for (const e of found) e.fill(0);
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
          // A check that failed is a wrong passphrase.
        } finally {
          signerMod.wipe(a.value);
        }
        if (ok) return;
      }
      this.log.warn('re-authentication for the recovery phrase failed (wrong passphrase)');
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
      const a = await this.o.bridge.ask({
        kind: 'recovery-confirm',
        positions,
        retry: attempt > 1,
      });
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

  /**
   * Our own coded refusals (`IpcError`s with fixed sentences) pass; anything else — a library's
   * or core's message, which this code does not control — becomes `internal`, its allow-listed
   * reason logged.
   */
  private async guarded<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof IpcError) throw e;
      this.log.warn('a recovery phrase step failed', { reason: reasonOf(e) });
      throw hostError('internal', 'the recovery phrase step did not finish (see the log)');
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
    if (this.busy) fail('rate-limited', 'a recovery phrase window is already open');
    this.busy = true;
    try {
      return await f();
    } finally {
      this.busy = false;
    }
  }
}
