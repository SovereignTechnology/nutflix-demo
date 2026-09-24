/**
 * NIP-46 (remote signer) and NIP-07 (browser extension) adapters for the `Signer` contract.
 *
 * Both hand signing to something this process does not control, so neither result is taken on
 * trust: every event that comes back must verify (`verifyIncoming`, the package's one
 * verification boundary), be signed by the pubkey pinned at connect time, and carry EXACTLY
 * the kind, created_at, tags and content that were asked for. A signer that returns a
 * different event — a compromised bunker, a malicious extension, a relay-side swap of the
 * NIP-46 reply — is refused before the event reaches a relay (SECURITY.md T9/T14).
 *
 * Neither adapter holds the user's private key. The NIP-46 transport (client key, relays) is
 * `nostr-tools`' `BunkerSigner`, injected so this module needs no network in its tests.
 */
import type { NostrEvent, NostrPubkey, Signer } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import { checkSignInput, type SignInput } from './local.js';

const PUBKEY = /^[0-9a-f]{64}$/;

/** Refuse a remote-signed event unless it is exactly the request, signed by `pubkey`. */
export function checkRemoteSigned(
  request: SignInput,
  returned: unknown,
  pubkey: NostrPubkey,
): NostrEvent {
  const ev = verifyIncoming(returned);
  if (ev === null) throw new Error('remote-signer: returned an event that does not verify');
  if (ev.pubkey !== pubkey)
    throw new Error('remote-signer: returned an event signed by another key');
  const sameTags =
    ev.tags.length === request.tags.length &&
    ev.tags.every(
      (t, i) =>
        t.length === request.tags[i]?.length && t.every((v, j) => v === request.tags[i]?.[j]),
    );
  if (
    ev.kind !== request.kind ||
    ev.created_at !== request.created_at ||
    ev.content !== request.content ||
    !sameTags
  )
    throw new Error('remote-signer: returned a different event than the one requested');
  return ev;
}

function requestTemplate(event: SignInput): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags.map((t) => [...t]),
    content: event.content,
  };
}

function checkPeer(peer: string): void {
  if (typeof peer !== 'string' || !PUBKEY.test(peer))
    throw new Error('invalid-argument: peer pubkey must be 64 lower-case hex');
}

// ---------------------------------------------------------------------------------------
// NIP-46
// ---------------------------------------------------------------------------------------

/** The slice of `nostr-tools` `BunkerSigner` this adapter uses. */
export interface BunkerLike {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<unknown>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  close(): Promise<void>;
}

export class Nip46Signer implements Signer {
  readonly kind = 'nip46' as const;
  private locked = false;
  private closed = false;

  private constructor(
    private readonly bunker: BunkerLike,
    private readonly pubkey: NostrPubkey,
    /** "relay + remote pubkey" for `SignerStatus.detail` (no secret: the URI's secret is not kept). */
    readonly detail: string,
  ) {}

  /**
   * Adopt a connected bunker. The signing pubkey is asked for ONCE and pinned; every later
   * result must carry it. `relays` only feeds the status line.
   */
  static async adopt(bunker: BunkerLike, relays: readonly string[]): Promise<Nip46Signer> {
    const pk = await bunker.getPublicKey();
    if (typeof pk !== 'string' || !PUBKEY.test(pk)) {
      await bunker.close();
      throw new Error('remote-signer: the bunker returned an invalid pubkey');
    }
    const relay = relays[0] ?? 'unknown relay';
    return new Nip46Signer(bunker, pk as NostrPubkey, `${relay} · ${pk.slice(0, 8)}…`);
  }

  private ready(): void {
    if (this.closed) throw new Error('no-signer: the remote signer was disconnected');
    if (this.locked) throw new Error('signer-locked: the remote signer is locked');
  }

  getPublicKey(): Promise<NostrPubkey> {
    try {
      this.ready();
      return Promise.resolve(this.pubkey);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('remote-signer: failed'));
    }
  }

  async signEvent(event: SignInput): Promise<NostrEvent> {
    this.ready();
    checkSignInput(event, this.pubkey);
    const returned = await this.bunker.signEvent(requestTemplate(event));
    return checkRemoteSigned(event, returned, this.pubkey);
  }

  async nip44Encrypt(peerPubkey: NostrPubkey, plaintext: string): Promise<string> {
    this.ready();
    checkPeer(peerPubkey);
    if (typeof plaintext !== 'string')
      throw new Error('invalid-argument: plaintext must be a string');
    const out = await this.bunker.nip44Encrypt(peerPubkey, plaintext);
    if (typeof out !== 'string') throw new Error('remote-signer: nip44 encrypt returned no string');
    return out;
  }

  async nip44Decrypt(peerPubkey: NostrPubkey, ciphertext: string): Promise<string> {
    this.ready();
    checkPeer(peerPubkey);
    if (typeof ciphertext !== 'string')
      throw new Error('invalid-argument: ciphertext must be a string');
    const out = await this.bunker.nip44Decrypt(peerPubkey, ciphertext);
    if (typeof out !== 'string') throw new Error('remote-signer: nip44 decrypt returned no string');
    return out;
  }

  /** "Lock" a remote signer: refuse to use it until `unlock()` (the key is not ours to wipe). */
  lock(): Promise<void> {
    this.locked = true;
    return Promise.resolve();
  }

  unlock(): void {
    if (!this.closed) this.locked = false;
  }

  isLocked(): boolean {
    return this.locked || this.closed;
  }

  /** Sign out: close the NIP-46 session. The adapter is unusable afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.locked = true;
    await this.bunker.close();
  }
}

// ---------------------------------------------------------------------------------------
// NIP-07
// ---------------------------------------------------------------------------------------

/** `window.nostr` as NIP-07 describes it (structural: core has no DOM lib). */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<unknown>;
  readonly nip44?: {
    encrypt(peer: string, plaintext: string): Promise<string>;
    decrypt(peer: string, ciphertext: string): Promise<string>;
  };
}

export class Nip07Signer implements Signer {
  readonly kind = 'nip07' as const;
  private locked = false;

  private constructor(
    private readonly provider: Nip07Provider,
    /** `provider.nip44`, called as a method of itself (extensions may rely on `this`). */
    private readonly nip44: NonNullable<Nip07Provider['nip44']>,
    private readonly pubkey: NostrPubkey,
  ) {}

  /** Adopt an extension. Refuses one without NIP-44 (the wallet needs it, build-plan §3). */
  static async adopt(provider: Nip07Provider | null | undefined): Promise<Nip07Signer> {
    if (provider === null || provider === undefined)
      throw new Error('no-signer: no NIP-07 extension detected');
    const nip44 = provider.nip44;
    if (nip44 === undefined) throw new Error('no-signer: the extension does not support NIP-44');
    const pk = await provider.getPublicKey();
    if (typeof pk !== 'string' || !PUBKEY.test(pk))
      throw new Error('remote-signer: the extension returned an invalid pubkey');
    // Keep the provider object itself: spreading it would drop prototype methods.
    return new Nip07Signer(provider, nip44, pk as NostrPubkey);
  }

  private ready(): void {
    if (this.locked) throw new Error('signer-locked: the extension signer is locked');
  }

  getPublicKey(): Promise<NostrPubkey> {
    try {
      this.ready();
      return Promise.resolve(this.pubkey);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('remote-signer: failed'));
    }
  }

  async signEvent(event: SignInput): Promise<NostrEvent> {
    this.ready();
    checkSignInput(event, this.pubkey);
    const returned = await this.provider.signEvent(requestTemplate(event));
    return checkRemoteSigned(event, returned, this.pubkey);
  }

  async nip44Encrypt(peerPubkey: NostrPubkey, plaintext: string): Promise<string> {
    this.ready();
    checkPeer(peerPubkey);
    if (typeof plaintext !== 'string')
      throw new Error('invalid-argument: plaintext must be a string');
    const out = await this.nip44.encrypt(peerPubkey, plaintext);
    if (typeof out !== 'string') throw new Error('remote-signer: nip44 encrypt returned no string');
    return out;
  }

  async nip44Decrypt(peerPubkey: NostrPubkey, ciphertext: string): Promise<string> {
    this.ready();
    checkPeer(peerPubkey);
    if (typeof ciphertext !== 'string')
      throw new Error('invalid-argument: ciphertext must be a string');
    const out = await this.nip44.decrypt(peerPubkey, ciphertext);
    if (typeof out !== 'string') throw new Error('remote-signer: nip44 decrypt returned no string');
    return out;
  }

  lock(): Promise<void> {
    this.locked = true;
    return Promise.resolve();
  }

  unlock(): void {
    this.locked = false;
  }

  isLocked(): boolean {
    return this.locked;
  }
}
