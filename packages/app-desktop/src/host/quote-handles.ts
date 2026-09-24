/**
 * Opaque mint-quote handles (security review F17). A mint quote id is bearer where the mint lacks
 * NUT-20 (or the key is signer-held): whoever learns it once the invoice is paid can mint the
 * ecash. So the id never reaches the renderer — the host hands out a random handle in its place
 * (`quoteId: "h…"`), keeps the real quote, and resolves the handle when the renderer polls. The
 * renderer's copy of the quote is never trusted: polling uses the STORED quote (mint, amount).
 * `wallet.change` quote events are translated the same way. Handles are scoped to the wallet that
 * issued them (`generation`, bumped when the signer changes): a quote made for one identity is
 * never polled — and minted — by the next.
 */
import type { MintQuote, WalletChangeEvent } from '@sovit/core';

import { toHex } from '../ipc/codec.js';
import { fail } from './errors.js';

/** Quotes remembered at once; the oldest is forgotten first. */
export const MAX_QUOTE_HANDLES = 256;

export class QuoteHandles {
  private readonly byHandle = new Map<string, MintQuote>();
  private readonly byId = new Map<string, string>();
  private at: number;

  constructor(
    private readonly random: (n: number) => Uint8Array,
    private readonly generation: () => number = () => 0,
  ) {
    this.at = generation();
  }

  /** Make a quote with the current wallet; refused if the wallet changed meanwhile. */
  async make(create: () => Promise<MintQuote>): Promise<MintQuote> {
    const at = this.generation();
    const quote = await create();
    if (this.generation() !== at)
      fail('payments-unavailable', 'the signer changed while the quote was being made');
    return this.issue(quote);
  }

  /** `quote` as the renderer may see it: its id replaced by a stable handle. */
  issue(quote: MintQuote): MintQuote {
    this.sync();
    let handle = this.byId.get(this.key(quote));
    if (handle === undefined) {
      handle = `h${toHex(this.random(16))}`;
      this.byId.set(this.key(quote), handle);
      while (this.byHandle.size >= MAX_QUOTE_HANDLES) {
        const oldest = this.byHandle.keys().next().value;
        if (oldest === undefined) break;
        const q = this.byHandle.get(oldest);
        this.byHandle.delete(oldest);
        if (q !== undefined) this.byId.delete(this.key(q));
      }
    }
    this.byHandle.set(handle, quote);
    return { ...quote, quoteId: handle };
  }

  /** The real quote behind the renderer's copy (its handle); `not-found` for anything else. */
  resolve(renderer: MintQuote): MintQuote {
    this.sync();
    const q = this.byHandle.get(renderer.quoteId);
    if (q === undefined) fail('not-found', 'unknown mint quote');
    return q;
  }

  /** A wallet event as the renderer may see it. */
  translate(e: WalletChangeEvent): WalletChangeEvent {
    return e.type === 'quote' ? { ...e, quote: this.issue(e.quote) } : e;
  }

  /** Forget every handle once the wallet that issued them is gone. */
  private sync(): void {
    const now = this.generation();
    if (now === this.at) return;
    this.at = now;
    this.byHandle.clear();
    this.byId.clear();
  }

  private key(q: MintQuote): string {
    return `${q.mint} ${q.quoteId}`;
  }
}
