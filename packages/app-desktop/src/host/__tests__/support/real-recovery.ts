/**
 * Test support (not a suite): ADR 0016 on CORE's real NUT-13 code (lane N1, wired at
 * `recovery/core.ts` `recoveryCore()`) — integration fix 2.
 *
 *   spyRecoveryCore  core's real phrases, seed option and seeded view, recording what the money
 *                    plane handed them: a spy that passes every call through, never a fake.
 *                    `loseOption` makes the seed option come back empty (a core whose option key
 *                    was renamed), the one stand-in, where losing the option is the point.
 *   recoveryProfile  a complete host (`rig`) whose "main" answers the prompt window and the
 *                    native dialogs like a user who writes the words down: the local key made or
 *                    imported (`secretKeyHex`, so two profiles can be one identity on two devices),
 *                    a passphrase, "create my wallet", the words shown and the three asked, every
 *                    native confirm accepted (the reissue fee), no keychain. It records the words
 *                    main was shown and every HostOut as main received it (a structured clone).
 *
 * The fakes of `fake-recovery.ts` stay for the service's unit tests, whose money plane is a stub:
 * a fake seed never reaches a real `MoneyPlane` (core refuses a seed it did not make).
 */
import type { MintUrl, NostrPubkey, Sats } from '@sovit/core';
import { signer as signerMod, wallet as walletMod } from '@sovit/core';
import type { nostr } from '@sovit/core';

import type { HostOut, PromptAnswer, ReplyMsg } from '../../../ipc/protocol.js';
import { IPC_V } from '../../../ipc/protocol.js';
import type { RecoveryCore } from '../../recovery/core.js';
import { recoveryCore } from '../../recovery/core.js';
import type { Rig, RigOptions } from './rig.js';
import { eventually, rig } from './rig.js';

export interface SpyRecoveryCore {
  readonly core: RecoveryCore;
  /** Every seed material a money plane opened with, in order. */
  readonly materials: walletMod.SeedMaterial[];
  /** Every wallet `seeded` was asked about, in order. */
  readonly asked: walletMod.CashuWallet[];
}

/** Core's real recovery code, recording what the plane handed it (see the module comment). */
export function spyRecoveryCore(o: { readonly loseOption?: boolean } = {}): SpyRecoveryCore {
  const real = recoveryCore();
  if (real === undefined) throw new Error('recoveryCore() is not wired');
  const materials: walletMod.SeedMaterial[] = [];
  const asked: walletMod.CashuWallet[] = [];
  return {
    core: {
      phrases: real.phrases,
      seedOption: (m) => {
        materials.push(m);
        return o.loseOption === true ? {} : real.seedOption(m);
      },
      seeded: (w) => {
        asked.push(w);
        return real.seeded(w);
      },
      phraseTag: (seed) => real.phraseTag(seed),
    },
    materials,
    asked,
  };
}

/** Core's real seed for a phrase given as its entropy in hex. */
export function seedOf(hex: string): Promise<walletMod.RecoverySeed> {
  return walletMod.recoveryPhrases.toSeed(walletMod.entropyFromHex(hex));
}

export interface RecoveryProfile {
  readonly r: Rig;
  readonly spy: SpyRecoveryCore;
  /** The words (BIP-39 indices) of every `recovery-show` form, as main received them. */
  readonly shown: (readonly number[])[];
  /** The kind of every native confirm main was asked. */
  readonly confirms: string[];
  /** Each HostOut as main received it: a structured clone taken when it was posted. */
  readonly posted: HostOut[];
  /** The renderer calls `method` (IPC wire, webContents 3); resolves with the reply. */
  invoke(method: string, args?: unknown[]): Promise<ReplyMsg>;
  /** Connect the local key (made, or imported from `secretKeyHex`); resolves with its pubkey. */
  connect(): Promise<NostrPubkey>;
  close(): Promise<void>;
}

export interface RecoveryProfileOptions {
  readonly mintRequest: NonNullable<RigOptions['mintRequest']>;
  readonly mints: readonly MintUrl[];
  readonly passphrase: string;
  /** Import this key (64 hex) instead of making one: the same identity on another device. */
  readonly secretKeyHex?: string;
  /** The relays as this device finds them (default: empty). */
  readonly pool?: nostr.FakeRelayPool;
  /** Main's answer to `recovery-restore` (default: no typed words or mints). */
  readonly restoreAnswer?: Extract<PromptAnswer, { kind: 'recovery-restore' }>;
}

let nextId = 1;

export async function recoveryProfile(o: RecoveryProfileOptions): Promise<RecoveryProfile> {
  const spy = spyRecoveryCore();
  const shown: (readonly number[])[] = [];
  const confirms: string[] = [];
  const posted: HostOut[] = [];
  const enc = new TextEncoder();
  const r = await rig({
    mintRequest: o.mintRequest,
    signerCost: signerMod.minimumCost(),
    recoveryCore: spy.core,
    ...(o.pool === undefined ? {} : { pool: o.pool }),
    onOut: (out, host) => {
      posted.push(structuredClone(out));
      if (out.kind === 'prompt') {
        const f = out.form;
        let a: PromptAnswer | null = null;
        if (f.kind === 'local-setup')
          a = {
            kind: 'local-setup',
            method: 'passphrase',
            flow: o.secretKeyHex === undefined ? 'generate' : 'import',
          };
        else if (f.kind === 'import-nsec' && o.secretKeyHex !== undefined)
          a = { kind: 'secret', value: enc.encode(o.secretKeyHex) };
        else if (f.kind === 'new-passphrase' || f.kind === 'recovery-reauth')
          a = { kind: 'secret', value: enc.encode(o.passphrase) };
        else if (f.kind === 'create-wallet') a = { kind: 'create-wallet', create: true };
        else if (f.kind === 'recovery-show') {
          shown.push([...f.words]);
          a = { kind: 'recovery-show', done: true };
        } else if (f.kind === 'recovery-confirm') {
          const words = shown.at(-1) ?? [];
          a = { kind: 'recovery-confirm', words: f.positions.map((p) => words[p] ?? 0) };
        } else if (f.kind === 'recovery-restore')
          a = o.restoreAnswer ?? { kind: 'recovery-restore', words: [] };
        queueMicrotask(() => {
          host().handle({ kind: 'prompt-answer', req: out.req, answer: a });
        });
      } else if (out.kind === 'confirm') {
        confirms.push(out.form.kind);
        queueMicrotask(() => {
          host().handle({ kind: 'confirm-result', req: out.req, ok: true });
        });
      } else if (out.kind === 'keychain') {
        queueMicrotask(() => {
          host().handle({ kind: 'keychain-result', req: out.req, ok: false, value: null });
        });
      }
    },
  });
  await r.host.adapter.updateSettings({ defaultMints: [...o.mints] });
  await r.ready();
  const invoke = async (method: string, args: unknown[] = []): Promise<ReplyMsg> => {
    const id = nextId++;
    r.host.handle({ kind: 'call', wc: 3, msg: { v: IPC_V, id, method, args } });
    const out = await r.until(
      (x): x is Extract<HostOut, { kind: 'reply' }> =>
        x.kind === 'reply' && x.wc === 3 && x.msg.id === id,
      `reply to ${method}`,
      60_000,
    );
    return out.msg;
  };
  return {
    r,
    spy,
    shown,
    confirms,
    posted,
    invoke,
    connect: async () => {
      const spawned = r.spawned.length;
      const connected = await invoke('desktop.signer.connect', [{ kind: 'local' }]);
      if (!connected.ok) throw new Error(`connect refused: ${connected.error.code}`);
      await eventually(() => r.spawned.length > spawned, 'the worker restart after connect');
      await r.ready();
      return (connected.result as { pubkey: NostrPubkey }).pubkey;
    },
    close: () => r.close(),
  };
}

/**
 * Fund the profile's wallet at `mint` with `sats` (the user's own Lightning top-up): `pay` settles
 * the invoice (the TestMint's `payQuote`; nothing for a real mint's FakeWallet, which settles it by
 * itself), then the quote is polled until issued.
 */
export async function fundWallet(
  p: RecoveryProfile,
  mint: MintUrl,
  sats: number,
  pay: (quoteId: string) => void = () => undefined,
): Promise<void> {
  const wallet = p.r.host.adapter.wallet;
  const q = await wallet.mintQuote(mint, sats as Sats);
  pay(q.quoteId);
  for (let i = 0; i < 100; i++) {
    if ((await wallet.pollQuote(q)).state === 'ISSUED') return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('the mint never marked the quote paid');
}

/** The kinds a relay keeps when it has lost the wallet's ecash events (tokens, history, deletions). */
export const LOST_ECASH_KINDS: ReadonlySet<number> = new Set([7375, 7376, 5]);
