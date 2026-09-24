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
 * `connect` handshake and never stored or reported.
 */
import { BUNKER_REGEX, BunkerSigner, type BunkerPointer } from 'nostr-tools/nip46';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { generateSecretKey } from 'nostr-tools/pure';

import type { BunkerLike } from './remote.js';

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

/** Open and `connect()` a NIP-46 session. Rejects if the bunker does not answer `connect`. */
export async function connectBunker(
  uri: string,
  opts: { readonly pool?: AbstractSimplePool } = {},
): Promise<{ readonly bunker: BunkerLike; readonly relays: readonly string[] }> {
  const bp = parseBunkerUri(uri);
  const signer = BunkerSigner.fromBunker(
    generateSecretKey(),
    bp,
    opts.pool === undefined ? {} : { pool: opts.pool },
  );
  try {
    await signer.connect();
  } catch {
    await signer.close().catch(() => undefined);
    throw new Error('remote-signer: the bunker did not answer connect');
  }
  return { bunker: signer, relays: bp.relays };
}
