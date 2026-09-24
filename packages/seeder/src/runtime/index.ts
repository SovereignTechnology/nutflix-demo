/**
 * The seeder daemon's runtime: everything `cli/main.ts` needs beyond the config to run a paid
 * seeder (execution plan §4, build-plan Phase 3; decisions in ADR 0011).
 *
 *   identity   `LocalSigner` from the encrypted key file, passphrase from a systemd credential
 *   wallet     `CashuWallet` over `FileProofStore` (<dataDir>/wallet/proofs.json, 0600, NIP-44
 *              encrypted to the node's own key), redeeming
 *              with the key file's wallet key (`signSecret`: the key stays in the signer)
 *   engine     `RealPaymentEngine` with every hook wired: rate-limited keysets, redeem, NUT-07
 *              `checkSpent` / `spentByUs`, the durable pending queue and seen set, nutzaps
 *   mints      `node:http(s)` via `mint-http.ts`, never the global `fetch` (a crash under --jitless)
 *   nostr      NIP-61 nutzaps and the kind 10019 over a `ws`-backed relay pool
 *   pay/1      a `PayChannel` + HELLO on every admitted session (`pay-wiring.ts`)
 *   payout     above a threshold, the balance goes to the owner's wallet as a nutzap (`payout.ts`)
 *
 * Node only: reachable from `cli/providers.ts`, never from `portable.ts` (entry-hygiene.test.ts).
 */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_WINDOW_BLOCKS, payment, wallet as walletMod } from '@sovit/core';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  RelayUrl,
  Signer,
  nostr,
} from '@sovit/core';

import type { DaemonConfig, PayoutConfig } from '../cli/config-file.js';
import type { Logger } from '../log/logger.js';
import { DleqPool, defaultDleqThreads } from './dleq-pool.js';
import type { Seeder } from '../seeder.js';
import { PendingJournal, SeenLog } from './engine-state.js';
import { RuntimeSetupError } from './files.js';
import { PASSPHRASE_CREDENTIAL, unlockIdentity } from './identity.js';
import { guardedKeyset } from './keysets.js';
import { nodeMintRequest } from './mint-http.js';
import { announceNutzapInfo, createRelayPool, nutzapPublisher } from './nostr-publish.js';
import { wirePay } from './pay-wiring.js';
import { Payout } from './payout.js';
import { FileProofStore, selfCipher } from './proof-file.js';

/** Secrets the seen set keeps in memory (~300 B each, ~75 MB): older replays are caught at the mint. */
export const SEEN_CAPACITY = 250_000;

type RequestFn = NonNullable<
  ConstructorParameters<typeof walletMod.CashuMintConnections>[0]
>['request'];

export interface SeederRuntimeOptions {
  /** `$CREDENTIALS_DIRECTORY` (systemd). */
  readonly credentialsDirectory: string | undefined;
  readonly logger: Logger;
  /** Tests: the in-process `TestMint` transport. Default: `node:http(s)` to the mint (`mint-http.ts`). */
  readonly mintRequest?: RequestFn;
  /** Tests: a `FakeRelayPool`. Default: a real relay pool over `ws`. */
  readonly pool?: nostr.PoolLike;
  /** Tests: the built DLEQ worker, for a runtime loaded from sources (default: next to this module). */
  readonly dleqWorkerUrl?: URL;
  /**
   * The most accepted-but-unredeemed PAYs held before sessions stop being served (default
   * `DEFAULT_MAX_PENDING_PAYS`): while a mint is down nothing redeems, and the queue — in memory
   * and in the journal — would otherwise grow without bound.
   */
  readonly maxPendingPays?: number;
}

/** See `SeederRuntimeOptions.maxPendingPays`. */
export const DEFAULT_MAX_PENDING_PAYS = 4096;

/** What a node's runtime needs beyond the shell's own config (the daemon's, the gateway's). */
export interface NodeRuntimeOptions extends SeederRuntimeOptions {
  /** Where `wallet/` lives (the node's 0700 state directory). */
  readonly dataDir: string;
  readonly keyFile: string;
  /** The systemd credential id holding the key file's passphrase. */
  readonly credential: string;
  /** Mints this node takes payment at (its HELLO's), and holds ecash at. */
  readonly acceptedMints: readonly MintUrl[];
  readonly windowBlocks: number;
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
  /** Where nutzaps and the kind 10019 go. */
  readonly relays: readonly RelayUrl[];
  /** The creator Nostr pubkey whose clients look for nutzaps to `lockedTo` (`undefined` = none). */
  readonly recipientFor: (lockedTo: CashuP2pkPubkey) => NostrPubkey | undefined;
  readonly videoEventFor?: (core: CoreKeyHex) => NostrEventId | undefined;
  readonly payout: PayoutConfig | null;
  /**
   * Attach `pay/1` + HELLO to every session of the seeder passed to `attach` (the daemon). A shell
   * with its own wiring (the gateway) passes `false`.
   */
  readonly wirePay: boolean;
  /**
   * DLEQ worker threads (security review F5): default `defaultDleqThreads()`; `0` checks on the
   * event loop. Without the built worker file (vitest on sources) checks stay inline.
   */
  readonly dleqThreads?: number;
}

export interface SeederRuntime {
  readonly engine: payment.RealPaymentEngine;
  readonly wallet: walletMod.CashuWallet;
  readonly pubkey: NostrPubkey;
  readonly p2pk: CashuP2pkPubkey;
  /** Signs as this node (HELLO for a shell that sends its own); nothing else of the key is exposed. */
  readonly signEvent: Signer['signEvent'];
  /** `null` when `payout` is not configured (earnings stay in the wallet file). */
  readonly payout: Payout | null;
  /** Before `seeder.start()`: pay/1 on every session, then the kind 10019 (best effort). */
  attach(seeder: Seeder): void;
  /**
   * `SeederDeps.accepting`: `false` while the pending-PAY queue is at `maxPendingPays` (a mint
   * outage). Pass it to the `Seeder` this runtime pays for.
   */
  readonly accepting: () => boolean;
  /** After `seeder.close()` (its final flush has run): relays closed, key locked, lock freed. */
  close(): Promise<void>;
}

/** Lock files this process holds: a second runtime here on the same directory is refused. */
const heldHere = new Set<string>();

/**
 * One daemon per data directory: two would both redeem, both rewrite the wallet file and lose
 * each other's proofs. `wx` creation is atomic; a lock whose process is gone is taken over. A lock
 * naming THIS pid is stale too — a daemon restarted after a reboot can get its old pid back — so a
 * second runtime inside this process is caught by `heldHere` instead.
 */
function acquireLock(path: string): () => void {
  const pid = process.pid;
  if (heldHere.has(path))
    throw new RuntimeSetupError(`this process already runs a seeder on ${path}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${String(pid)}\n`);
      } finally {
        closeSync(fd);
      }
      // Two starts racing over one stale lock can each remove it and create their own; the one
      // whose pid is not in the file lost. (Narrows, does not close, that race — ADR 0011 §3.)
      if (readFileSync(path, 'utf8').trim() !== String(pid))
        throw new RuntimeSetupError(`another seeder took ${path} at the same time`);
      heldHere.add(path);
      return () => {
        heldHere.delete(path);
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'EEXIST') throw err;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    } catch {
      // unreadable: treat as stale
    }
    let alive = false;
    if (Number.isSafeInteger(holder) && holder > 0 && holder !== pid) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch (err) {
        alive = (err as { code?: unknown } | null)?.code === 'EPERM';
      }
    }
    if (alive)
      throw new RuntimeSetupError(
        `another seeder (pid ${String(holder)}) holds ${path}: one daemon per data directory`,
      );
    try {
      unlinkSync(path);
    } catch {
      // raced with its owner's cleanup
    }
  }
  throw new RuntimeSetupError(`could not take the state lock ${path}`);
}

/** The seeder daemon's runtime, from its config (`cli/config-file.ts`). */
export async function createSeederRuntime(
  config: DaemonConfig,
  o: SeederRuntimeOptions,
): Promise<SeederRuntime> {
  const policy = config.seeder.policy;
  if (policy === undefined) throw new RuntimeSetupError('the daemon needs a price policy');
  return createNodeRuntime({
    ...o,
    dataDir: config.seeder.dataDir,
    keyFile: config.keyFile,
    credential: PASSPHRASE_CREDENTIAL,
    acceptedMints: policy.mints,
    windowBlocks: DEFAULT_WINDOW_BLOCKS,
    flushEveryBlocks: config.seeder.flushEveryBlocks ?? 64,
    flushEveryMs: config.seeder.flushEveryMs ?? 60_000,
    relays: config.relays,
    recipientFor: (lockedTo) =>
      lockedTo.toLowerCase() === policy.creatorP2pk.toLowerCase()
        ? config.creatorPubkey
        : undefined,
    videoEventFor: (core) => config.videoEvents.get(core),
    payout: config.payout,
    wirePay: true,
  });
}

/** A node's money runtime (ADR 0011): identity, wallet, seeder-side engine, nutzaps, payout. */
export async function createNodeRuntime(o: NodeRuntimeOptions): Promise<SeederRuntime> {
  const log = o.logger.child({ component: 'runtime' });
  // Read-only first: a node without its key or passphrase refuses before it creates anything.
  const identity = await unlockIdentity({
    keyFile: o.keyFile,
    credentialsDirectory: o.credentialsDirectory,
    credential: o.credential,
  });
  const walletDir = join(o.dataDir, 'wallet');
  let release: () => void;
  try {
    mkdirSync(walletDir, { recursive: true, mode: 0o700 });
    chmodSync(walletDir, 0o700); // an existing directory keeps its mode through mkdir
    release = acquireLock(join(walletDir, 'lock'));
  } catch (err) {
    await identity.signer.lock();
    throw err;
  }

  let dleqPool: DleqPool | null = null;
  let journal: PendingJournal | null = null;
  try {
    const store = await FileProofStore.open(
      join(walletDir, 'proofs.json'),
      selfCipher(identity.signer, identity.pubkey),
    );
    if (store.migrated) log.warn('wallet file was unencrypted — resealed to this node’s key');
    const httpRequest = nodeMintRequest();
    const mints = new walletMod.CashuMintConnections({
      request: o.mintRequest ?? (() => httpRequest),
    });
    const wallet = new walletMod.CashuWallet({
      mints,
      store,
      key: walletMod.signerWalletKey(identity.signer, identity.p2pk),
      configuredMints: o.acceptedMints,
    });

    const seenLog = new SeenLog(join(walletDir, 'seen.jsonl'), SEEN_CAPACITY, (err) => {
      log.error('seen-secrets append failed (a cache: replays are still caught at the mint)', {
        error: err,
      });
    });
    const seen = new payment.SeenSecrets({ capacity: SEEN_CAPACITY, persist: seenLog.append });
    seen.restore(seenLog.load());

    const pool = o.pool ?? createRelayPool();
    journal = PendingJournal.open(
      join(walletDir, 'pending.jsonl'),
      join(walletDir, 'pending.json'),
      (err) => {
        log.error('pending-PAY write failed: accepted payments are in memory only', {
          error: err,
        });
      },
    );
    const pending = journal.items;
    const windowBlocks = o.windowBlocks;
    dleqPool = DleqPool.open({
      size: o.dleqThreads ?? defaultDleqThreads(),
      logger: log,
      ...(o.dleqWorkerUrl === undefined ? {} : { workerUrl: o.dleqWorkerUrl }),
    });
    if (dleqPool !== null) log.info('DLEQ checks off the event loop', { threads: dleqPool.size });
    const engine = new payment.RealPaymentEngine({
      config: {
        windowBlocks,
        acceptedMints: [...o.acceptedMints],
        ownP2pk: identity.p2pk,
        ownPubkey: identity.pubkey,
        flushEveryBlocks: o.flushEveryBlocks,
        flushEveryMs: o.flushEveryMs,
      },
      seen,
      keyset: guardedKeyset((m: MintUrl, id: string) => wallet.keyset(m, id)),
      redeem: (set) => wallet.receive(set),
      checkSpent: (set) => wallet.checkSpent(set),
      spentByUs: (set) => wallet.spentByUs(set),
      persistPending: journal.persist,
      nutzap: nutzapPublisher({
        signer: identity.signer,
        pool,
        relays: o.relays,
        recipientFor: o.recipientFor,
        ...(o.videoEventFor === undefined ? {} : { videoEventFor: o.videoEventFor }),
      }),
      ...(dleqPool === null ? {} : { dleq: dleqPool.verify }),
    });
    const po = o.payout;
    if (po !== null && (po.pubkey === identity.pubkey || po.p2pk === identity.p2pk))
      throw new RuntimeSetupError(
        'payout names this node’s own key: set payout.pubkey / payout.p2pk to the owner’s wallet',
      );
    const payout =
      po === null
        ? null
        : new Payout({
            wallet,
            signer: identity.signer,
            pool,
            owner: { pubkey: po.pubkey, p2pk: po.p2pk },
            relays: po.relays,
            thresholdSats: po.thresholdSats,
            logPath: join(walletDir, 'payouts.jsonl'),
            logger: o.logger,
          });
    const runPayout = (): void => {
      payout?.run().catch((err: unknown) => {
        log.error('payout run failed', { error: err });
      });
    };

    engine.restorePending(pending);
    if (pending.length > 0) log.info('restored accepted PAYs', { pending: engine.pendingCount() });

    const unsubs: (() => void)[] = [];
    let closed = false;
    const maxPending = o.maxPendingPays ?? DEFAULT_MAX_PENDING_PAYS;
    let full = false;
    const accepting = (): boolean => {
      const ok = engine.pendingCount() < maxPending;
      if (ok === full) {
        // Log each transition once, not per block.
        full = !ok;
        if (full)
          log.warn('pending-PAY queue at its cap: not serving until the mint takes redeems again', {
            pending: engine.pendingCount(),
            cap: maxPending,
          });
        else
          log.info('pending-PAY queue below its cap again: serving', {
            pending: engine.pendingCount(),
          });
      }
      return ok;
    };
    return {
      engine,
      wallet,
      accepting,
      pubkey: identity.pubkey,
      p2pk: identity.p2pk,
      signEvent: (e) => identity.signer.signEvent(e),
      payout,
      attach(seeder) {
        if (o.wirePay)
          unsubs.push(
            wirePay(seeder, {
              signer: identity.signer,
              p2pk: identity.p2pk,
              windowBlocks,
              logger: o.logger,
            }),
          );
        if (payout === null)
          log.warn(
            'no payout configured: earnings stay in the wallet file (see payout in the config)',
          );
        else {
          // Whatever was earned before a restart, then after every flush that swapped sats in.
          runPayout();
          unsubs.push(
            seeder.on((e) => {
              if (e.type === 'flush' && e.result.swapped > 0) runPayout();
            }),
          );
        }
        // Load every accepted mint now: the first PAY then verifies against keysets already in
        // memory, and an unreachable mint shows up at start, not at the first payment.
        for (const m of o.acceptedMints)
          mints.wallet(m).then(
            (w) => {
              log.info('mint loaded', { mint: m, keysets: w.keyChain.getKeysets().length });
            },
            (err: unknown) => {
              log.warn('mint not reachable at start (retried on the first payment)', {
                mint: m,
                error: err,
              });
            },
          );
        announceNutzapInfo({
          signer: identity.signer,
          pool,
          relays: o.relays,
          mints: o.acceptedMints,
          p2pk: identity.p2pk,
        }).then(
          (ok) => {
            log.info('kind 10019 published', { relays: ok.length });
          },
          (err: unknown) => {
            log.warn('kind 10019 not published', { error: err });
          },
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const off of unsubs) off();
        await payout?.idle();
        pool.close();
        await dleqPool?.close();
        journal?.close();
        await identity.signer.lock();
        release();
      },
    };
  } catch (err) {
    await dleqPool?.close();
    journal?.close();
    await identity.signer.lock();
    release();
    throw err;
  }
}
