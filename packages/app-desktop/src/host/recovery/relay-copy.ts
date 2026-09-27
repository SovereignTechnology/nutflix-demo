/**
 * ADR 0016 D2: the recovery phrase's relay copy — a kind 30078 event (NIP-78 app data) whose `d`
 * is `nutflix/nut13/<device id>` (a random id per phrase, no other identifier) and whose content
 * is the phrase's entropy NIP-44-encrypted to self: the SAME ciphertext as the sealed file on
 * this device (`RecoveryRelayCopy` as plaintext). No other tag, so the event says nothing about
 * the device, the app build or the mints.
 *
 *   publish  when a phrase is created or rotated (never at startup);
 *   read     ONLY by an explicit restore: every `nutflix/nut13/*` copy of the signed-in identity
 *            on its read relays, signature-checked, newest per `d`, blanks dropped, at most
 *            `MAX_RELAY_COPIES` decrypted through the signer (the rest counted); a copy that does
 *            not decrypt or parse is counted and skipped;
 *   retire   after a rotation whose reissue completed: a blank replacement (so relays that
 *            ignore deletions drop the ciphertext too) and a NIP-09 deletion — both best effort
 *            (ADR 0016: the old copy may survive on some relay; the reissue already moved the
 *            funds it could restore).
 *
 * Nothing here logs; the caller reports counts only.
 */
import type {
  NostrEvent,
  NostrPubkey,
  RelayUrl,
  Signer,
  UnixSeconds,
  wallet as walletTypes,
} from '@sovit/core';
import { nostr, wallet as walletMod } from '@sovit/core';

const DEVICE_ID = /^[0-9a-f]{32}$/;
const ENTROPY_HEX = /^[0-9a-f]{32}$/;
/** Copies a restore reads at most (one per phrase this identity ever made). */
export const MAX_RELAY_COPIES = 64;
/** NIP-09 deletion. */
const DELETION_KIND = 5;

export interface RecoveryRelays {
  readonly pool: nostr.PoolLike;
  /** The user's write relays (publish). */
  readonly write: () => readonly RelayUrl[];
  /** The user's read relays (restore). */
  readonly read: () => readonly RelayUrl[];
  /** Relay wait per query, ms (default 5000). */
  readonly maxWaitMs?: number;
}

/** The copy's `d` tag. */
export function copyD(device: string): string {
  if (!DEVICE_ID.test(device)) throw new Error('invalid-argument: not a device id');
  return `${walletMod.RECOVERY_D_PREFIX}${device}`;
}

/** Exactly a `RecoveryRelayCopy` (as JSON text), or `null`. Pure; never throws. */
export function parseRelayCopy(text: string): walletTypes.RecoveryRelayCopy | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'created,entropy,v' || o['v'] !== 1) return null;
  const { entropy, created } = o;
  if (typeof entropy !== 'string' || !ENTROPY_HEX.test(entropy)) return null;
  if (typeof created !== 'number' || !Number.isSafeInteger(created) || created < 0) return null;
  return { v: 1, entropy, created };
}

/** Publish (or replace) a phrase's copy. `true` when at least one write relay accepted it. */
export async function publishRelayCopy(o: {
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly relays: RecoveryRelays;
  readonly device: string;
  /** NIP-44 to self of the `RecoveryRelayCopy` JSON (the sealed file's `sealed`). */
  readonly sealed: string;
  readonly now: () => UnixSeconds;
}): Promise<boolean> {
  const write = o.relays.write();
  if (write.length === 0) return false;
  const ev = await o.signer.signEvent({
    kind: walletMod.RECOVERY_RELAY_KIND,
    created_at: o.now(),
    tags: [['d', copyD(o.device)]],
    content: o.sealed,
  });
  const res = await o.relays.pool.publish(write, ev);
  return res.some((r) => r.ok);
}

/** What a restore found on the relays. */
export interface RelayCopies {
  readonly copies: readonly { readonly device: string; readonly entropy: string }[];
  /** Copies of this identity that did not decrypt or parse (another app, a damaged event). */
  readonly unreadable: number;
  /** Live copies left undecrypted by the `MAX_RELAY_COPIES` cap (counted, never silent). */
  readonly omitted: number;
}

/** Every copy of `pubkey` it can decrypt (only for an explicit restore). */
export async function readRelayCopies(o: {
  readonly signer: Pick<Signer, 'nip44Decrypt'>;
  readonly pubkey: NostrPubkey;
  readonly relays: RecoveryRelays;
}): Promise<RelayCopies> {
  const read = o.relays.read();
  if (read.length === 0) return { copies: [], unreadable: 0, omitted: 0 };
  const raw = await o.relays.pool.query(
    read,
    { kinds: [walletMod.RECOVERY_RELAY_KIND], authors: [o.pubkey], limit: 500 },
    { maxWaitMs: o.relays.maxWaitMs ?? 5000 },
  );
  const newest = new Map<string, NostrEvent>();
  for (const r of raw) {
    const ev = nostr.verifyIncoming(r);
    if (ev?.pubkey !== o.pubkey || ev.kind !== walletMod.RECOVERY_RELAY_KIND) continue;
    const ds = ev.tags.filter((t) => t[0] === 'd');
    const d = ds.length === 1 ? ds[0]?.[1] : undefined;
    if (d?.startsWith(walletMod.RECOVERY_D_PREFIX) !== true) continue;
    const device = d.slice(walletMod.RECOVERY_D_PREFIX.length);
    if (!DEVICE_ID.test(device)) continue;
    const seen = newest.get(device);
    if (seen === undefined || nostr.byNewest(ev, seen) < 0) newest.set(device, ev);
  }
  // A retired copy's blank replacement is skipped BEFORE the cap, so blanks never crowd out a
  // live copy; what the cap leaves out is counted (independent review IR10).
  const live = [...newest].filter(([, ev]) => ev.content !== '');
  const copies: { device: string; entropy: string }[] = [];
  let unreadable = 0;
  for (const [device, ev] of live.slice(0, MAX_RELAY_COPIES)) {
    let copy: walletTypes.RecoveryRelayCopy | null;
    try {
      copy = parseRelayCopy(await o.signer.nip44Decrypt(o.pubkey, ev.content));
    } catch {
      copy = null;
    }
    if (copy === null) unreadable++;
    else copies.push({ device, entropy: copy.entropy });
  }
  return { copies, unreadable, omitted: Math.max(0, live.length - MAX_RELAY_COPIES) };
}

/** Best effort: blank a retired copy and ask relays to delete it (NIP-09). Never throws. */
export async function retireRelayCopy(o: {
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly pubkey: NostrPubkey;
  readonly relays: RecoveryRelays;
  readonly device: string;
  readonly now: () => UnixSeconds;
}): Promise<boolean> {
  try {
    const write = o.relays.write();
    if (write.length === 0) return false;
    const d = copyD(o.device);
    const blank = await o.signer.signEvent({
      kind: walletMod.RECOVERY_RELAY_KIND,
      created_at: o.now(),
      tags: [['d', d]],
      content: '',
    });
    const deletion = await o.signer.signEvent({
      kind: DELETION_KIND,
      created_at: o.now(),
      tags: [
        ['a', `${String(walletMod.RECOVERY_RELAY_KIND)}:${o.pubkey}:${d}`],
        ['k', String(walletMod.RECOVERY_RELAY_KIND)],
      ],
      content: '',
    });
    const [a, b] = await Promise.all([
      o.relays.pool.publish(write, blank),
      o.relays.pool.publish(write, deletion),
    ]);
    return a.some((r) => r.ok) && b.some((r) => r.ok);
  } catch {
    return false;
  }
}
