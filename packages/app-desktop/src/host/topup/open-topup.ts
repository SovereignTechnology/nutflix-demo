/**
 * An open auto top-up (cross-lane review round 4, money high): what a later run needs to finish a
 * top-up whose melt may have paid the target's invoice — or paid it before the target minted.
 *
 *   quote   the target mint's quote (NUT-04): polled, and minted once PAID, by the identity that
 *           created it (a NUT-20 locked quote carries its lock in the mint's own answer, so the
 *           wallet key signs it then; an unlocked one is bearer money once paid);
 *   melt    the source mint and its melt quote id: whether that melt is still journaled, and the
 *           mint's own state of it, say whether the invoice can still be paid;
 *   before  the source's history just before the melt (its newest time and the ids there): the
 *           anchor that finds the melt's history line once the journal settles it, so the line
 *           reads "top-up".
 *
 * Serialised as JSON, then sealed to the owner by the money plane (`TopUpVault.seal`) before it
 * is written to the ledger. Read back strictly: every key, every shape, or nothing (`null`).
 * Nothing here logs.
 */
import type { MintQuote, MintUrl } from '@sovit/core';

import type { Guard } from '../../ipc/guards.js';
import { arrayOf, int, literal, matches, nullable, obj, oneOf } from '../../ipc/guards.js';
import { isHistoryId, isLedgerMint } from './ledger.js';

const RECORD_V = 1 as const;
/** History ids kept as the anchor (the top-up reads this many before the melt). */
export const MAX_ANCHOR_IDS = 20;

export interface OpenTopUp {
  readonly quote: MintQuote;
  readonly melt: { readonly mint: MintUrl; readonly quoteId: string };
  /** `null` when the source's history could not be read before the melt (then nothing is labelled). */
  readonly before: { readonly newest: number; readonly ids: readonly string[] } | null;
}

interface Wire {
  readonly v: typeof RECORD_V;
  readonly quote: MintQuote;
  readonly melt: { readonly mint: MintUrl; readonly quoteId: string };
  readonly before: { readonly newest: number; readonly ids: readonly string[] } | null;
}

/** A mint's quote id: printable ASCII, bounded (cashu mints use UUIDs or base64url ids). */
const isQuoteId = matches(/^[\x21-\x7e]{1,256}$/, 256);
/**
 * An invoice the record keeps: bounded so the sealed record always fits the ledger's
 * `MAX_OPEN_CHARS` (a longer one refuses the top-up before anything moves).
 */
const isBolt11 = matches(/^ln[0-9a-z]+$/i, 4096);

const isQuote: Guard<MintQuote> = obj({
  mint: isLedgerMint,
  quoteId: isQuoteId,
  amount: int(1, Number.MAX_SAFE_INTEGER),
  bolt11: isBolt11,
  expiry: int(0, Number.MAX_SAFE_INTEGER),
  state: oneOf(['UNPAID', 'PAID', 'ISSUED'] as const),
});

const isMelt: Guard<Wire['melt']> = obj({ mint: isLedgerMint, quoteId: isQuoteId });

const isAnchor: Guard<NonNullable<Wire['before']>> = obj({
  newest: int(0, Number.MAX_SAFE_INTEGER),
  ids: arrayOf(isHistoryId, MAX_ANCHOR_IDS),
});

const isWire: Guard<Wire> = obj({
  v: literal(RECORD_V),
  quote: isQuote,
  melt: isMelt,
  before: nullable(isAnchor),
});

/** The record as the text the money plane seals. */
export function serializeOpenTopUp(r: OpenTopUp): string {
  const wire: Wire = {
    v: RECORD_V,
    quote: {
      mint: r.quote.mint,
      quoteId: r.quote.quoteId,
      amount: r.quote.amount,
      bolt11: r.quote.bolt11,
      expiry: r.quote.expiry,
      state: r.quote.state,
    },
    melt: { mint: r.melt.mint, quoteId: r.melt.quoteId },
    // An id the ledger would not store is left out (it can only mislabel that one line), never
    // the reason a top-up does not run.
    before:
      r.before === null
        ? null
        : {
            newest: r.before.newest,
            ids: r.before.ids.filter(isHistoryId).slice(0, MAX_ANCHOR_IDS),
          },
  };
  if (!isWire(wire)) throw new Error('not an open top-up the ledger can keep');
  return JSON.stringify(wire);
}

/** Unsealed text → the record, or `null` for anything not exactly one (never throws). */
export function parseOpenTopUp(text: string): OpenTopUp | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isWire(raw)) return null;
    return { quote: raw.quote, melt: raw.melt, before: raw.before };
  } catch {
    return null;
  }
}
