/**
 * The NIP-60 wallet event (kind 17375) and the user's nutzap info (kind 10019) — build-plan §3
 * "NIP-60 P2PK key: dedicated wallet key in kind 17375. Pear: decrypt via signer nip44, hold in
 * sodium-native secure memory".
 *
 *   kind 17375  nip44(self, [["privkey", <hex>], ["mint", <url>], …]) — the wallet's own P2PK key
 *               (NOT the Nostr key: NIP-61 forbids locking to it) and its mints. Replaceable.
 *   kind 10019  [["relay", …], ["mint", <url>, "sat"], ["pubkey", <compressed P2PK>]] — where the
 *               user takes nutzaps: what seeders, gateways and viewers lock creator shares to.
 *
 * `openNip60Wallet` reads the newest 17375 by the user (signature and author verified). It makes a
 * NEW wallet key only when asked to (`create: true`, a deliberate first-time setup): an empty
 * relay answer also means "relays unreachable", and 17375 is replaceable — creating on a mere
 * miss would replace the user's real wallet key on their relays and strand every proof locked to
 * it. With a signer that holds the wallet key
 * itself (`signSecret`, e.g. a `LocalSigner` created with one) the key never enters this module;
 * otherwise it is decrypted into secure memory and `close()` wipes it.
 *
 * Limit: the signer's NIP-44 returns the decrypted rows as a JS string, which cannot be wiped; the
 * key is copied into secure memory at once and the string dropped for the collector. A signer with
 * `signSecret` for this key avoids even that.
 *
 * No cryptography is implemented here (nostr-tools key generation, the signer's NIP-44, cashu-ts
 * key derivation). Nothing logs; errors name the problem, never a key.
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools/pure';

import type {
  CashuP2pkPubkey,
  MintUrl,
  NostrEvent,
  RelayUrl,
  Signer,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import { normalizeMintUrl } from '../nostr/nutzap-info.js';
import { verifyIncoming } from '../nostr/event.js';
import { secureCopy, wipe } from '../signer/secure.js';
import type { Nip60Relays } from './nip60.js';
import type { WalletKey } from './spend.js';
import { memoryWalletKey, signerWalletKey } from './wallet.js';

const HEX64 = /^[0-9a-f]{64}$/;

export interface Nip60Wallet {
  /** Signs NUT-11 witnesses for proofs locked to `p2pk`. */
  readonly key: WalletKey;
  /** The wallet key's compressed public half: the user's P2PK target (kind 10019 `pubkey`). */
  readonly p2pk: CashuP2pkPubkey;
  /** The mints the wallet event lists. */
  readonly mints: readonly MintUrl[];
  /** True when this call made the wallet key (and published the 17375). */
  readonly created: boolean;
  /** How the key is held — the UI must tell the user (build-plan §3). */
  readonly mode: 'signer' | 'memory';
  /** Wipe a key held in memory. Idempotent. */
  close(): void;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The decrypted rows of a 17375, or `null` when they are not a wallet. */
function parseRows(text: string): { privkey: string; mints: MintUrl[] } | null {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  let privkey: string | null = null;
  const mints: MintUrl[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') continue;
    if (r[0] === 'privkey' && HEX64.test(r[1])) privkey = r[1];
    if (r[0] === 'mint') {
      const m = normalizeMintUrl(r[1]);
      if (m !== null && !mints.includes(m)) mints.push(m);
    }
  }
  return privkey === null ? null : { privkey, mints };
}

export interface OpenNip60WalletOptions {
  readonly signer: Signer;
  readonly relays: Nip60Relays;
  /** Mints for a NEW wallet event (an existing one keeps its own). */
  readonly defaultMints: readonly MintUrl[];
  /**
   * Make and publish a new wallet key when none is found. Only for an explicit "create my wallet"
   * (default false): see the module comment for why a miss must not create one.
   */
  readonly create?: boolean;
  readonly now?: () => UnixSeconds;
}

/** Load the user's wallet key (kind 17375), or make and publish one. */
export async function openNip60Wallet(o: OpenNip60WalletOptions): Promise<Nip60Wallet> {
  const me = await o.signer.getPublicKey();
  const now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  const raw = await o.relays.query({ kinds: [NostrKind.WalletInfo], authors: [me] });
  let newest: NostrEvent | null = null;
  for (const r of raw) {
    // Re-verified here whatever the relay layer promised: a forged 17375 "from us" would hand
    // the user a wallet key someone else knows.
    const ev = verifyIncoming(r);
    if (ev?.pubkey !== me || ev.kind !== NostrKind.WalletInfo) continue;
    if (newest === null || ev.created_at > newest.created_at) newest = ev;
  }

  let rows: { privkey: string; mints: MintUrl[] } | null = null;
  if (newest !== null) {
    let text: string;
    try {
      text = await o.signer.nip44Decrypt(me, newest.content);
    } catch {
      throw new Error('wallet-unreadable: the NIP-60 wallet event does not decrypt with this key');
    }
    rows = parseRows(text);
    if (rows === null)
      throw new Error('wallet-unreadable: the NIP-60 wallet event carries no wallet key');
  }

  let created = false;
  if (rows === null && o.create !== true)
    throw new Error(
      'no-wallet: no NIP-60 wallet event was found on your relays (create one explicitly; relays may also be unreachable)',
    );
  if (rows === null) {
    const fresh = generateSecretKey();
    const mints = [...new Set(o.defaultMints)];
    const content = JSON.stringify([['privkey', hex(fresh)], ...mints.map((m) => ['mint', m])]);
    wipe(fresh);
    const ev = await o.signer.signEvent({
      kind: NostrKind.WalletInfo,
      created_at: now(),
      tags: [],
      content: await o.signer.nip44Encrypt(me, content),
    });
    await o.relays.publish(ev);
    rows = parseRows(content);
    if (rows === null) throw new Error('wallet-unreadable: could not build the wallet event');
    created = true;
  }

  const raw32 = unhex(rows.privkey);
  const sk = secureCopy(raw32);
  wipe(raw32);
  let p2pk: CashuP2pkPubkey;
  try {
    p2pk = hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey;
  } catch {
    wipe(sk);
    throw new Error('wallet-unreadable: the wallet key is not a valid secp256k1 key');
  }
  if (p2pk.slice(2) === me) {
    wipe(sk);
    throw new Error('wallet-unreadable: the wallet key is the Nostr key (NIP-61 forbids it)');
  }
  // A signer that holds this same key signs witnesses itself; the copy here is not needed.
  const bySigner = o.signer.signSecret !== undefined && signerP2pk(o.signer) === p2pk;
  if (bySigner) wipe(sk);
  let closed = false;
  return {
    key: bySigner ? signerWalletKey(o.signer, p2pk) : memoryWalletKey(sk),
    p2pk,
    mints: rows.mints,
    created,
    mode: bySigner ? 'signer' : 'memory',
    close: () => {
      if (closed) return;
      closed = true;
      wipe(sk);
    },
  };
}

/** A signer's own wallet P2PK, when it exposes one (`LocalSigner.walletP2pk`). */
function signerP2pk(s: Signer): string | null {
  const v = (s as { walletP2pk?: unknown }).walletP2pk;
  return typeof v === 'string' ? v : null;
}

/** Publish the user's kind 10019: where they take nutzaps (NIP-61). */
export async function publishNutzapInfo(o: {
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly relays: Pick<Nip60Relays, 'publish'>;
  readonly readRelays: readonly RelayUrl[];
  readonly mints: readonly MintUrl[];
  readonly p2pk: CashuP2pkPubkey;
  readonly now?: () => UnixSeconds;
}): Promise<NostrEvent> {
  const now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  const ev = await o.signer.signEvent({
    kind: NostrKind.NutzapInfo,
    created_at: now(),
    content: '',
    tags: [
      ...o.readRelays.map((r) => ['relay', r]),
      ...o.mints.map((m) => ['mint', m, 'sat']),
      ['pubkey', o.p2pk],
    ],
  });
  await o.relays.publish(ev);
  return ev;
}
