/**
 * The default NIP-46 connector for `SignerManager`: parse a `bunker://` URI and open a
 * `nostr-tools` `BunkerSigner` session over its relays.
 *
 * Only `bunker://<64-hex>?relay=wss://…[&secret=…]` is accepted. `nostr-tools`'
 * `parseBunkerInput` also resolves `name@domain` through a NIP-05 HTTPS fetch; that path is
 * NOT taken here — the host would fetch a URL named by user input (the same class of problem as
 * NIP-05 profile lookups, L6-B contract request 3), and a bunker URI is what signers hand out.
 * Relays must be `wss://` (a `ws://` relay would carry the NIP-46 channel in the clear; it is
 * encrypted with NIP-44, but its metadata is not).
 *
 * The client key for the NIP-46 channel is generated per session and held by `BunkerSigner`
 * (it can sign nothing but the channel's own requests). The URI's `secret` is used once for the
 * `connect` handshake and never stored or reported. With `remember` the client key and the
 * bunker pointer are also handed back as `resume` bytes, so a host that can SEAL them (the
 * desktop's OS keychain, ADR 0013) can reopen the session at the next launch (`resumeBunker`).
 * They let their holder ask the bunker for signatures, within what the bunker allows this client.
 *
 * Setup is bounded (`timeoutMs`): nostr-tools waits for a bunker's answer forever, and a revoked
 * client is simply never answered.
 */
import { BUNKER_REGEX, BunkerSigner, type BunkerPointer } from 'nostr-tools/nip46';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import type { BunkerLike } from './remote.js';

const HEX64 = /^[0-9a-f]{64}$/;

function isWss(r: string): boolean {
  try {
    return new URL(r).protocol === 'wss:';
  } catch {
    return false;
  }
}

export function parseBunkerUri(uri: string): BunkerPointer {
  if (typeof uri !== 'string') throw new Error('invalid-argument: expected a bunker:// URI');
  const m = BUNKER_REGEX.exec(uri.trim());
  if (m === null)
    throw new Error('invalid-argument: expected bunker://<64-hex pubkey>?relay=wss://…');
  const pubkey = m[1];
  const qs = new URLSearchParams(m[2] ?? '');
  const relays = qs.getAll('relay');
  if (pubkey === undefined || relays.length === 0)
    throw new Error('invalid-argument: the bunker URI names no relay');
  for (const r of relays) {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      throw new Error('invalid-argument: a bunker relay is not a URL');
    }
    if (u.protocol !== 'wss:') throw new Error('invalid-argument: bunker relays must be wss://');
  }
  return { pubkey, relays, secret: qs.get('secret') };
}

/** How long setup waits for the bunker to answer (`connect`, then `get_public_key`). */
export const BUNKER_SETUP_TIMEOUT_MS = 60_000;

export interface BunkerOptions {
  readonly pool?: AbstractSimplePool;
  /** Setup deadline in ms (default `BUNKER_SETUP_TIMEOUT_MS`). A bunker may wait on its user. */
  readonly timeoutMs?: number;
  /**
   * Also return `resume`: what `resumeBunker` needs to reopen this session later without the
   * URI. Only for a caller that seals it (the desktop's OS keychain).
   */
  readonly remember?: boolean;
  /**
   * A bunker's `auth_url` challenge (a URL for the user to open). Default: ignored. Never left to
   * nostr-tools, which would `console.warn` the URL — often carrying a session token — past the
   * host's redacting logger.
   */
  readonly onauth?: (url: string) => void;
}

function bunkerParams(opts: Omit<BunkerOptions, 'remember'>): {
  pool?: AbstractSimplePool;
  onauth: (url: string) => void;
} {
  return {
    ...(opts.pool === undefined ? {} : { pool: opts.pool }),
    onauth: opts.onauth ?? ((): void => undefined),
  };
}

export interface BunkerSession {
  readonly bunker: BunkerLike;
  readonly relays: readonly string[];
  /**
   * With `remember`: the channel's client key and the bunker pointer, as UTF-8 JSON bytes. It
   * lets its holder ask the bunker to sign whatever the bunker lets this client sign, so it is a
   * secret: seal it, then `wipe()` it. The URI's one-time `secret` is not in it.
   */
  readonly resume?: Uint8Array;
}

/** Rejects with `remote-signer` when `p` has not settled within `ms`, after `onTimeout`. */
async function within<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('remote-signer: the bunker did not answer in time'));
    }, ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

interface Opened {
  readonly signer: BunkerSigner;
  /** What callers hold: closing it also closes a pool this module made. */
  readonly bunker: BunkerLike;
  readonly dispose: () => Promise<void>;
}

/**
 * A `BunkerSigner` on `opts.pool`, or on a pool of its own that is closed with it: left alone,
 * nostr-tools makes a pool per signer and `close()` leaves its relay sockets open.
 */
function open(
  clientKey: Uint8Array,
  bp: BunkerPointer,
  opts: Omit<BunkerOptions, 'remember'>,
): Opened {
  const own = opts.pool === undefined ? new SimplePool() : undefined;
  const pool = opts.pool ?? own;
  const signer = BunkerSigner.fromBunker(
    clientKey,
    bp,
    bunkerParams(pool === undefined ? opts : { ...opts, pool }),
  );
  const dispose = async (): Promise<void> => {
    await signer.close().catch(() => undefined);
    own?.close(bp.relays);
  };
  const bunker: BunkerLike =
    own === undefined
      ? signer
      : {
          getPublicKey: () => signer.getPublicKey(),
          signEvent: (t) => signer.signEvent(t),
          nip44Encrypt: (peer, text) => signer.nip44Encrypt(peer, text),
          nip44Decrypt: (peer, text) => signer.nip44Decrypt(peer, text),
          close: dispose,
        };
  return { signer, bunker, dispose };
}

/** Ask for the user's pubkey now (bounded), so `Nip46Signer.adopt` finds it cached. */
async function warmUp(o: Opened, ms: number): Promise<void> {
  const closeQuietly = (): void => {
    void o.dispose();
  };
  try {
    await within(o.signer.getPublicKey(), ms, closeQuietly);
  } catch (e) {
    closeQuietly();
    if (e instanceof Error && e.message.startsWith('remote-signer:')) throw e;
    throw new Error('remote-signer: the bunker did not return a pubkey', { cause: e });
  }
}

function encodeResume(clientKey: Uint8Array, bp: BunkerPointer): Uint8Array {
  const json = JSON.stringify({
    v: 1,
    key: bytesToHex(clientKey),
    pubkey: bp.pubkey,
    relays: bp.relays,
  });
  return new TextEncoder().encode(json);
}

/** Open and `connect()` a NIP-46 session. Rejects if the bunker does not answer in time. */
export async function connectBunker(uri: string, opts: BunkerOptions = {}): Promise<BunkerSession> {
  const bp = parseBunkerUri(uri);
  const ms = opts.timeoutMs ?? BUNKER_SETUP_TIMEOUT_MS;
  // BunkerSigner keeps THIS array as its channel key (no copy): it must not be wiped here.
  const clientKey = generateSecretKey();
  const o = open(clientKey, bp, opts);
  try {
    await within(o.signer.connect(), ms, () => undefined);
  } catch {
    await o.dispose();
    throw new Error('remote-signer: the bunker did not answer connect');
  }
  await warmUp(o, ms);
  const relays = bp.relays;
  return opts.remember === true
    ? { bunker: o.bunker, relays, resume: encodeResume(clientKey, { ...bp, secret: null }) }
    : { bunker: o.bunker, relays };
}

/**
 * Reopen a remembered NIP-46 session (`connectBunker(…, { remember: true })`'s `resume`) without
 * a new `connect`: the bunker already knows this client key. Rejects `remote-signer` when the
 * bunker does not answer in time (it may have revoked the client), `invalid-argument` for a blob
 * that is not a session. Does not wipe `resume`; the caller does.
 */
export async function resumeBunker(
  resume: Uint8Array,
  opts: Omit<BunkerOptions, 'remember'> = {},
): Promise<BunkerSession> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resume));
  } catch {
    throw new Error('invalid-argument: not a remembered NIP-46 session');
  }
  const o = parsed as { v?: unknown; key?: unknown; pubkey?: unknown; relays?: unknown };
  if (
    o.v !== 1 ||
    typeof o.key !== 'string' ||
    !HEX64.test(o.key) ||
    typeof o.pubkey !== 'string' ||
    !HEX64.test(o.pubkey) ||
    !Array.isArray(o.relays) ||
    o.relays.length === 0 ||
    o.relays.length > 16 ||
    !o.relays.every((r): r is string => typeof r === 'string' && isWss(r))
  )
    throw new Error('invalid-argument: not a remembered NIP-46 session');
  const bp: BunkerPointer = { pubkey: o.pubkey, relays: [...o.relays], secret: null };
  // Held by BunkerSigner from here on (no copy), like connectBunker's.
  const opened = open(hexToBytes(o.key), bp, opts);
  await warmUp(opened, opts.timeoutMs ?? BUNKER_SETUP_TIMEOUT_MS);
  return { bunker: opened.bunker, relays: bp.relays };
}
