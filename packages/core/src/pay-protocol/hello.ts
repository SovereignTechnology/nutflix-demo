/**
 * The `pay/1` HELLO key-possession proof, bound to one connection and one direction
 * (contracts v5, ADR 0010 §7).
 *
 *   challenge = `pay/1:<Noise handshake hash hex>:<sender's Noise static key hex>`
 *   signature = BIP-340 over the NIP-01 id of
 *               { kind: PAY_HELLO_KIND, pubkey, created_at: createdAt,
 *                 tags: [['challenge', challenge]], content: '' }
 *
 * Both ends of a Noise connection share the handshake hash and no other connection has it, so
 * a HELLO cannot be replayed onto another connection; the sender's key in the challenge means a
 * HELLO reflected back to its sender names the wrong key. The event is an ordinary NIP-01 event:
 * any `Signer.signEvent` signs it (a remote signer included — its reply is verified like any
 * other), `nostr-tools` verifies it. Nothing here is cryptography.
 */
import { getEventHash } from 'nostr-tools/pure';

import type {
  CashuP2pkPubkey,
  HelloMessage,
  MintUrl,
  Sats,
  Signer,
  UnixSeconds,
} from '../contracts/index.js';
import { PAY_HELLO_KIND, PAY_PROTOCOL_NAME, PAY_PROTOCOL_VERSION } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import { isValidSplit } from '../payment/split.js';

/** What both ends of one Noise connection know about it. */
export interface ConnectionBinding {
  readonly handshakeHash: Uint8Array;
  readonly localNoiseKey: Uint8Array;
  readonly remoteNoiseKey: Uint8Array;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const COMPRESSED = /^0[23][0-9a-f]{64}$/;
export const MAX_HELLO_MINTS = 16;

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** The challenge `sender` signs on this connection. */
export function helloChallenge(handshakeHash: Uint8Array, senderNoiseKey: Uint8Array): string {
  return `${PAY_PROTOCOL_NAME}:${hex(handshakeHash)}:${hex(senderNoiseKey)}`;
}

/**
 * The binding of a protomux instance made by Hypercore's `createProtocolStream` — its `stream`
 * is the Noise secret stream. `null` when the mux carries no completed handshake.
 */
export function bindingFromMux(mux: unknown): ConnectionBinding | null {
  const stream = (mux as { stream?: unknown } | null)?.stream as
    { handshakeHash?: unknown; publicKey?: unknown; remotePublicKey?: unknown } | undefined;
  const hh = stream?.handshakeHash;
  const local = stream?.publicKey;
  const remote = stream?.remotePublicKey;
  if (
    !(hh instanceof Uint8Array) ||
    !(local instanceof Uint8Array) ||
    !(remote instanceof Uint8Array)
  )
    return null;
  if (hh.length === 0 || local.length !== 32 || remote.length !== 32) return null;
  return { handshakeHash: hh, localNoiseKey: local, remoteNoiseKey: remote };
}

export interface HelloTerms {
  readonly acceptedMints: readonly MintUrl[];
  readonly satsPerBlock: Sats;
  readonly split: { readonly seeder: number; readonly creator: number };
  readonly p2pk: CashuP2pkPubkey;
  readonly windowBlocks: number;
}

/** Sign this end's HELLO for `binding` with the node's Nostr signer. */
export async function buildHello(
  signer: Pick<Signer, 'signEvent'>,
  binding: ConnectionBinding,
  terms: HelloTerms,
  now: () => UnixSeconds = () => Math.floor(Date.now() / 1000) as UnixSeconds,
): Promise<Omit<HelloMessage, 'type'>> {
  const challenge = helloChallenge(binding.handshakeHash, binding.localNoiseKey);
  const ev = await signer.signEvent({
    kind: PAY_HELLO_KIND,
    created_at: now(),
    tags: [['challenge', challenge]],
    content: '',
  });
  const hello: Omit<HelloMessage, 'type'> = {
    version: PAY_PROTOCOL_VERSION,
    pubkey: ev.pubkey,
    challenge,
    createdAt: ev.created_at as UnixSeconds,
    signature: ev.sig,
    acceptedMints: [...terms.acceptedMints],
    satsPerBlock: terms.satsPerBlock,
    split: { seeder: terms.split.seeder, creator: terms.split.creator },
    p2pk: terms.p2pk,
    windowBlocks: terms.windowBlocks,
  };
  const check = checkHelloTerms({ type: 'HELLO', ...hello });
  if (check !== null) throw new Error(`invalid-argument: ${check}`);
  return hello;
}

function checkHelloTerms(h: HelloMessage): string | null {
  if (h.version !== PAY_PROTOCOL_VERSION) return 'unsupported version';
  if (!HEX64.test(h.pubkey)) return 'bad pubkey';
  if (!HEX128.test(h.signature)) return 'bad signature encoding';
  if (h.acceptedMints.length > MAX_HELLO_MINTS) return 'too many mints';
  for (const m of h.acceptedMints) {
    let u: URL;
    try {
      u = new URL(m);
    } catch {
      return 'a mint is not a URL';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'a mint is not http(s)';
  }
  if (!Number.isSafeInteger(h.satsPerBlock) || h.satsPerBlock < 0) return 'bad price';
  if (!isValidSplit(h.split)) return 'bad split';
  if (!COMPRESSED.test(h.p2pk)) return 'bad P2PK key';
  if (!Number.isSafeInteger(h.windowBlocks) || h.windowBlocks < 0 || h.windowBlocks > 65_535)
    return 'bad window';
  return null;
}

/** A HELLO check's result. `reason` is short, for the protocol-error log — never key material. */
export type HelloVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Verify a HELLO received on `binding`. The result is a verdict object, not a bare
 * `string | null`, so that no caller can accept a HELLO by testing the result for truthiness.
 */
export function verifyHello(hello: HelloMessage, binding: ConnectionBinding): HelloVerdict {
  const why = helloProblem(hello, binding);
  return why === null ? { ok: true } : { ok: false, reason: why };
}

function helloProblem(hello: HelloMessage, binding: ConnectionBinding): string | null {
  const terms = checkHelloTerms(hello);
  if (terms !== null) return terms;
  if (hello.challenge !== helloChallenge(binding.handshakeHash, binding.remoteNoiseKey))
    return 'challenge is not bound to this connection';
  const unsigned = {
    kind: PAY_HELLO_KIND as number,
    pubkey: hello.pubkey,
    created_at: hello.createdAt,
    tags: [['challenge', hello.challenge]],
    content: '',
  };
  const ev = verifyIncoming({ ...unsigned, id: getEventHash(unsigned), sig: hello.signature });
  if (ev?.pubkey !== hello.pubkey) return 'bad signature';
  return null;
}
