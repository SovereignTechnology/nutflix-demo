/**
 * Test support (not a suite): L1's offline test kit, loaded from core's SOURCE the way L6-0's
 * tests load the ui classifiers (a runtime URL import, invisible to `tsc`). `TestSigner` is the
 * integration point L1 names for L6 (docs/lanes/L1.md): real Schnorr signatures through
 * nostr-tools, a reversible fake nip44. No key material is handled in this lane's code.
 *
 * Importing that module also registers L1's own one-test self-check of `TestSigner` in the
 * importing suite (it lives in a `__tests__` file); that is expected.
 */
import type { NostrEvent, NostrPubkey, Signer, VideoManifest } from '@sovit/core';
import type { nostr } from '@sovit/core';

export interface TestSignerLike extends Signer {
  readonly pubkey: NostrPubkey;
  readonly calls: readonly { readonly method: string; readonly peer?: string }[];
}

export interface CoreTestKit {
  readonly TestSigner: new () => TestSignerLike;
  /** Signs `fixture` (a manifest) as a NIP-71 event by `signer`. */
  signedVideo(signer: TestSignerLike, fixture: VideoManifest): Promise<NostrEvent>;
  sign(signer: TestSignerLike, draft: nostr.EventDraft): Promise<NostrEvent>;
  /** `{ ...ev, ...patch }` — a tampered copy whose signature no longer matches. */
  tamper(ev: NostrEvent, patch?: Partial<NostrEvent>): NostrEvent;
}

let kit: Promise<CoreTestKit> | undefined;

export function coreTestKit(): Promise<CoreTestKit> {
  kit ??= import(
    /* @vite-ignore */ new URL(
      '../../../../../core/src/nostr/__tests__/helpers.ts',
      import.meta.url,
    ).href
  ) as Promise<CoreTestKit>;
  return kit;
}
