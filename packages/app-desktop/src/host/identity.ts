/**
 * Signer seam (design §1 Host row; build-plan: "signer is `Signer` interface only — the local
 * encrypted signer lands in Stage 2"). The host never holds key material: a `Signer`
 * implementation (Stage 2, `core/src/signer/`, locked) plugs in here, and every write path asks
 * `signer()` for it. Stage 1 has none, so writes reject `no-signer: …`.
 */
import type { NostrPubkey, Signer, SignerStatus } from '@sovit/core';

export interface IdentityProvider {
  /** The connected, usable signer — `undefined` in Stage 1. */
  signer(): Signer | undefined;
  /** What `NetworkAdapter.signer()` reports. */
  status(): Promise<SignerStatus>;
  /** What `NetworkAdapter.me()` reports. */
  me(): Promise<NostrPubkey | null>;
  /** ADR 0013: status changes (connect, lock, unlock, sign out); absent = it never changes. */
  onStatus?(cb: (s: SignerStatus) => void): () => void;
}

/** Stage 1 default: nobody is signed in and nothing can be signed. */
export class NoIdentity implements IdentityProvider {
  signer(): undefined {
    return undefined;
  }
  status(): Promise<SignerStatus> {
    return Promise.resolve({
      kind: 'local',
      pubkey: null,
      locked: true,
      supportsSignSecret: false,
      detail: 'no signer yet (Stage 1 is read-only)',
    });
  }
  me(): Promise<NostrPubkey | null> {
    return Promise.resolve(null);
  }
}

/**
 * `--dev-mocks` only: a READ-ONLY viewer identity (a fixed public key, no private key anywhere),
 * so the screens that gate on `me() !== null` — Watch/Shorts refuse to play when signed out —
 * can drive the Stage 1 exit test. It reports itself locked and cannot sign: every write still
 * rejects `no-signer: …`. Never constructed without `--dev-mocks` (see `host.ts`).
 */
export class DevViewerIdentity implements IdentityProvider {
  readonly pubkey: NostrPubkey;
  constructor(pubkey: NostrPubkey) {
    this.pubkey = pubkey;
  }
  signer(): undefined {
    return undefined;
  }
  status(): Promise<SignerStatus> {
    return Promise.resolve({
      kind: 'local',
      pubkey: this.pubkey,
      locked: true,
      supportsSignSecret: false,
      detail: 'dev-mocks: fixture viewer identity, cannot sign',
    });
  }
  me(): Promise<NostrPubkey | null> {
    return Promise.resolve(this.pubkey);
  }
}

/** A real `Signer` behind the seam (Stage 2; tests use core's `TestSigner`). */
export class SignerIdentity implements IdentityProvider {
  private readonly s: Signer;
  constructor(signer: Signer) {
    this.s = signer;
  }
  signer(): Signer | undefined {
    return this.s.isLocked() ? undefined : this.s;
  }
  async status(): Promise<SignerStatus> {
    return {
      kind: this.s.kind,
      pubkey: await this.s.getPublicKey(),
      locked: this.s.isLocked(),
      supportsSignSecret: this.s.signSecret !== undefined,
    };
  }
  async me(): Promise<NostrPubkey | null> {
    return this.s.getPublicKey();
  }
}
