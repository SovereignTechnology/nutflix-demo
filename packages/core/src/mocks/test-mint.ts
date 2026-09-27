/**
 * TestMint — an in-process Cashu mint for tests and `--dev-mocks` rigs (Stage 2).
 *
 * It speaks the NUT-00/01/02/03/04/05/07/11/12 HTTP API through `@cashu/cashu-ts`'
 * `customRequest` hook (`new Mint(url, { customRequest: testMint.request })`), so the REAL
 * wallet and payment code runs against it end to end: real blind signatures, real DLEQ proofs,
 * real P2PK spending conditions, real double-spend state. Every cryptographic step is a
 * cashu-ts primitive (`createNewMintKeys`, `createBlindSignature`, `createDLEQProof`,
 * `verifyUnblindedSignature`, `verifyP2PKSpendingConditions`, `hashToCurve`) — nothing here is
 * crypto, and none of it may be imported by a production code path.
 *
 * Lightning is simulated: a mint quote is paid with `payQuote()`, a melt quote always pays — and
 * with a shared `TestLightning`, a melt at one TestMint pays the other TestMint's invoice (the
 * desktop's auto top-up, issue #2: melt at the source, mint at the target).
 * Test hooks: `issue()` mints proofs directly (optionally P2PK-locked, with extra NUT-10 tags),
 * `markSpent()` spends proofs behind everyone's back, `failNext()` injects a mint outage,
 * `holdNextMelt()` / `settleMelts()` answer a melt PENDING (its Lightning payment in flight) and
 * settle it later, as cdk and Nutshell do, `failNextMelt()` refuses a melt request with a code.
 * NUT-13 (ADR 0016): `rotateKeyset()` retires the active keyset (it stays listed, its proofs stay
 * spendable, as at a real mint) and makes a new one; `keysetVersion: 0` gives a v1 (`00…`) id,
 * whose NUT-13 derivation is BIP-32; `nut12: false` signs without DLEQ; `hostileRestore()` makes
 * `/v1/restore` sign whatever it is asked (a hostile mint amplifying a restore). A melt whose
 * blanks were already signed is refused 10002 before it spends or pays, as at Nutshell and cdk.
 */
import {
  Amount,
  MintOperationError,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  createP2PKsecret,
  createRandomRawBlindedMessage,
  blindMessage,
  constructUnblindedSignature,
  hashToCurve,
  pointFromHex,
  verifyMintQuoteSignature,
  verifyP2PKSpendingConditions,
  verifyUnblindedSignature,
  type Proof,
  type RequestFn,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';

import type { CashuProof, MintKeyset, MintUrl } from '../contracts/index.js';

const enc = new TextEncoder();

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function num(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') return Number(x);
  if (x instanceof Amount) return x.toNumber();
  if (typeof x === 'object' && x !== null && 'toNumber' in x) return (x as Amount).toNumber();
  return Number.NaN;
}

/** A proof with a plain-number amount (the wire shape both cashu-ts and the contracts accept). */
function wireProof(p: unknown): Proof {
  const q = p as Record<string, unknown>;
  return { ...(q as unknown as Proof), amount: Amount.from(num(q['amount'])) };
}

export interface TestMintOptions {
  readonly url: MintUrl;
  /** Deterministic keys (tests); random when absent. */
  readonly seed?: Uint8Array;
  readonly inputFeePpk?: number;
  /** Lightning fee reserve the melt quote asks for, in sats. Default 0. */
  readonly feeReserve?: number;
  /**
   * NUT-20 locked mint quotes (default on, like Nutshell and cdk). A locked quote mints only with
   * a signature by its pubkey. This mint checks the LEGACY message (cashu-ts's own verifier): a
   * wallet that sends the amended message first is refused with 20008 and must fall back, as
   * cashu-ts does with older mints — the amended form is exercised against real mints.
   */
  readonly nut20?: boolean;
  /** NUT-09 restore (default on, like Nutshell and cdk): signatures are remembered by `B_`. */
  readonly nut09?: boolean;
  /** Simulated Lightning shared with other TestMints: their melts pay this mint's invoices. */
  readonly lightning?: TestLightning;
  /**
   * The expiry (unix seconds) its mint quotes carry (default 4 102 444 800, 2100-01-01): a test of
   * what a wallet does once a quote's invoice has expired sets its own. Only the number the mint
   * answers: the quote stays payable (simulated Lightning keeps no clock).
   */
  readonly quoteExpiry?: number;
  /**
   * NUT-19 cached responses, advertised in `/v1/info` only (default off; cdk-mintd advertises it,
   * Nutshell does not by default). This mint caches nothing: the option exists so a test can show
   * what a client does when a mint advertises it — cashu-ts's own fetch transport then RETRIES a
   * cached endpoint after a network error (issue #8, fix round 2).
   */
  readonly nut19?: {
    readonly ttl: number;
    readonly cachedEndpoints: readonly { readonly method: 'GET' | 'POST'; readonly path: string }[];
  };
  /**
   * The keyset id version (NUT-02): 1 (default) gives a v2 `01…` id (NUT-13 derives by HMAC), 0 a
   * v1 `00…` id (NUT-13 derives by BIP-32, the counter a hardened index).
   */
  readonly keysetVersion?: 0 | 1;
  /** NUT-12 DLEQ proofs on every signature (default on, like Nutshell and cdk). */
  readonly nut12?: boolean;
}

/** One keyset: its keys, and whether it still signs (inactive keysets only redeem). */
interface TestKeyset {
  readonly id: string;
  readonly pub: Readonly<Record<string, Uint8Array>>;
  readonly priv: Readonly<Record<string, Uint8Array>>;
  active: boolean;
}

/**
 * Simulated Lightning between TestMints (tests only): each linked mint's invoices carry a tag of
 * their own, and a melt at any linked mint that pays one marks that mint's quote PAID.
 */
export class TestLightning {
  private readonly invoices = new Map<string, () => void>();
  private mints = 0;
  /** Invoices routed to another mint (tests assert what actually paid). */
  readonly paid: string[] = [];

  /** @internal A per-mint tag for its invoices (bech32 characters only). */
  link(): string {
    return `${bech32Digits(String(++this.mints))}x`;
  }

  /** @internal */
  register(request: string, pay: () => void): void {
    this.invoices.set(request, pay);
  }

  /** @internal A melt paid `request`: `true` when it was a linked mint's invoice. */
  pay(request: string): boolean {
    const p = this.invoices.get(request);
    if (p === undefined) return false;
    this.paid.push(request);
    p();
    return true;
  }
}

interface Quote {
  readonly amount: number;
  state: 'UNPAID' | 'PAID' | 'ISSUED';
  /** NUT-20: the key the quote is locked to. */
  readonly pubkey?: string;
}

interface MeltQuote {
  readonly amount: number;
  readonly request: string;
  state: 'UNPAID' | 'PENDING' | 'PAID';
}

/** A melt answered PENDING (`holdNextMelt`): what `settleMelts` needs to finish it. */
interface HeldMelt {
  readonly inputs: { readonly ys: string[]; readonly witnesses: (string | undefined)[] };
  readonly blanks: readonly SerializedBlindedMessage[];
  /** The change due on the blanks once it is paid. */
  readonly refund: number;
  /** The linked invoice was paid when the melt was answered (`lightning: 'now'`). */
  readonly paidNow: boolean;
}

export class TestMint {
  readonly url: MintUrl;
  /** Every keyset, oldest first; the last one is active (`rotateKeyset`). */
  private readonly sets: TestKeyset[] = [];
  private readonly keySeed: Uint8Array | undefined;
  private readonly keysetVersion: 0 | 1;
  private readonly nut12: boolean;
  /** `/v1/restore` signs up to this many unsigned outputs per request (`hostileRestore`). */
  private signOnRestore = 0;
  private readonly inputFeePpk: number;
  private readonly feeReserve: number;
  private readonly nut20: boolean;
  private readonly nut09: boolean;
  private readonly nut19: TestMintOptions['nut19'];
  private readonly quoteExpiry: number;
  /** B_ → the signature the mint gave it (NUT-09 restore; an output is never signed twice). */
  private readonly promises = new Map<string, SerializedBlindedSignature>();
  /** hex(Y) of every spent proof. */
  private readonly spent = new Set<string>();
  /** hex(Y) → the witness the proof was spent with (NUT-07 returns it). */
  private readonly witnesses = new Map<string, string>();
  private dropped = 0;
  private readonly quotes = new Map<string, Quote>();
  private readonly melts = new Map<string, MeltQuote>();
  private seq = 0;
  private failures = 0;
  /** Melt requests still to be refused with a code (`failNextMelt`). */
  private refuseMelts = 0;
  /** Melts still to be answered PENDING (`holdNextMelt`), and how their invoice is paid. */
  private holdMelts = 0;
  private holdLightning: 'now' | 'later' = 'later';
  /** Melts answered PENDING, by quote id, until `settleMelts`. */
  private readonly held = new Map<string, HeldMelt>();
  /** hex(Y) of every proof a PENDING melt holds (NUT-07 reads PENDING, a spend is refused). */
  private readonly pendingYs = new Set<string>();
  private readonly lightning: TestLightning | undefined;
  private readonly invoiceTag: string;
  /** Requests served, by path — tests assert what the code under test actually did. */
  readonly calls: string[] = [];

  constructor(o: TestMintOptions) {
    this.url = o.url;
    this.lightning = o.lightning;
    this.invoiceTag = o.lightning?.link() ?? '';
    this.inputFeePpk = o.inputFeePpk ?? 0;
    this.feeReserve = o.feeReserve ?? 0;
    this.nut20 = o.nut20 ?? true;
    this.nut09 = o.nut09 ?? true;
    this.nut19 = o.nut19;
    this.quoteExpiry = o.quoteExpiry ?? 4_102_444_800;
    this.keySeed = o.seed;
    this.keysetVersion = o.keysetVersion ?? 1;
    this.nut12 = o.nut12 ?? true;
    this.addKeyset();
  }

  /** The active keyset's id (the one new outputs are signed under). */
  get keysetId(): string {
    return this.active().id;
  }

  /** Every keyset id, oldest first (the last is active). */
  get keysetIds(): readonly string[] {
    return this.sets.map((k) => k.id);
  }

  private active(): TestKeyset {
    const k = this.sets.at(-1);
    if (k === undefined) throw new Error('test-mint: no keyset');
    return k;
  }

  private get pub(): Readonly<Record<string, Uint8Array>> {
    return this.active().pub;
  }

  private get priv(): Readonly<Record<string, Uint8Array>> {
    return this.active().priv;
  }

  private addKeyset(): string {
    // A seeded mint's later keysets are seeded too (their own seed: the n-th keyset's).
    const seed =
      this.keySeed === undefined
        ? undefined
        : Uint8Array.from(this.keySeed, (b, i) => (i === 0 ? (b + this.sets.length) & 0xff : b));
    const pair = createNewMintKeys(16, seed, {
      unit: 'sat',
      input_fee_ppk: this.inputFeePpk,
      versionByte: this.keysetVersion,
    });
    for (const k of this.sets) k.active = false;
    this.sets.push({ id: pair.keysetId, pub: pair.pubKeys, priv: pair.privKeys, active: true });
    return pair.keysetId;
  }

  /**
   * Retire the active keyset and sign under a new one (a keyset rotation). The old one stays in
   * `/v1/keysets` (inactive) and `/v1/keys/{id}`, and its proofs stay spendable. Returns the new id.
   */
  rotateKeyset(): string {
    return this.addKeyset();
  }

  /**
   * `/v1/restore` signs outputs it is asked about and never signed, as a hostile mint could: up to
   * `perRequest` per request (default: all of them). One per request is enough to keep a scan
   * going forever. `false` turns it off.
   */
  hostileRestore(on: boolean | { readonly perRequest: number } = true): void {
    this.signOnRestore = on === false ? 0 : on === true ? Number.MAX_SAFE_INTEGER : on.perRequest;
  }

  private keysOf(id: string): TestKeyset | undefined {
    return this.sets.find((k) => k.id === id);
  }

  /** The keyset in the contracts' shape (`MintKeyset`), for offline DLEQ verification. */
  keyset(fetchedAt = 0): MintKeyset {
    const keys: Record<string, string> = {};
    for (const [amount, k] of Object.entries(this.pub)) keys[amount] = hex(k);
    return {
      mint: this.url,
      id: this.keysetId,
      unit: 'sat',
      active: true,
      keys,
      ...(this.inputFeePpk > 0 ? { inputFeePpk: this.inputFeePpk } : {}),
      fetchedAt,
    };
  }

  /** Mark a mint quote paid (the simulated Lightning payment arrived). */
  payQuote(quoteId: string): void {
    const q = this.quotes.get(quoteId);
    if (q?.state === 'UNPAID') q.state = 'PAID';
  }

  /** Spend proofs behind everyone's back (another wallet, another instance, a restart). */
  markSpent(proofs: readonly Pick<CashuProof, 'secret'>[]): void {
    for (const p of proofs) this.spent.add(this.y(p.secret));
  }

  isSpent(secret: string): boolean {
    return this.spent.has(this.y(secret));
  }

  /** The next `n` requests fail as if the mint were down. */
  failNext(n = 1): void {
    this.failures += n;
  }

  /**
   * The next `n` state-changing requests (POST) are EXECUTED — proofs spent, quotes paid — but
   * their response is lost, as with a timeout after the mint committed.
   */
  dropNextResponse(n = 1): void {
    this.dropped += n;
  }

  /**
   * The next `n` melt requests (`POST /v1/melt/bolt11`) are refused with a code, as a mint whose
   * Lightning backend refused the payment up front: nothing is spent, the quote stays UNPAID.
   */
  failNextMelt(n = 1): void {
    this.refuseMelts += n;
  }

  /**
   * The next `n` melts are answered PENDING, as a mint does while its Lightning payment is still
   * in flight: the quote reads PENDING, its inputs read PENDING (NUT-07) and cannot be spent, and
   * no change is signed yet. `lightning: 'now'` pays the linked invoice at once (the receiver has
   * settled, the paying node has not said so yet); `'later'` (default) pays it in `settleMelts`.
   */
  holdNextMelt(n = 1, o: { readonly lightning?: 'now' | 'later' } = {}): void {
    this.holdMelts += n;
    this.holdLightning = o.lightning ?? 'later';
  }

  /**
   * Settle every melt answered PENDING. `'paid'`: the inputs are spent, the invoice is paid (if it
   * was not already), the change is signed on the melt's blanks (so NUT-09 restores it) and the
   * quote reads PAID. `'failed'`: the payment failed, the inputs are released and the quote reads
   * UNPAID. Returns how many melts it settled.
   */
  settleMelts(outcome: 'paid' | 'failed' = 'paid'): number {
    let n = 0;
    for (const [quote, h] of [...this.held]) {
      this.held.delete(quote);
      for (const y of h.inputs.ys) this.pendingYs.delete(y);
      const q = this.melts.get(quote);
      if (q === undefined) continue;
      n++;
      if (outcome === 'failed') {
        if (h.paidNow) throw new Error('test-mint: an invoice already paid cannot fail');
        q.state = 'UNPAID';
        continue;
      }
      this.spend(h.inputs);
      q.state = 'PAID';
      if (!h.paidNow) this.lightning?.pay(q.request);
      this.signChange(h.blanks, h.refund);
    }
    return n;
  }

  /**
   * Mint proofs directly (a test's starting balance), in power-of-two denominations, each with
   * DLEQ including the blinding factor `r` (NUT-12, what a wallet stores). `p2pk` locks them;
   * `tags` are extra NUT-10 tags committed into the secret.
   */
  issue(
    amount: number,
    opts: { readonly p2pk?: string; readonly tags?: readonly (readonly string[])[] } = {},
  ): CashuProof[] {
    const out: CashuProof[] = [];
    for (const a of denominations(amount)) {
      // A random NUT-00 secret, or a NUT-11 P2PK secret (random nonce) locked to `p2pk`.
      const plain = createRandomRawBlindedMessage();
      const secretStr =
        opts.p2pk === undefined
          ? new TextDecoder().decode(plain.secret)
          : createP2PKsecret(
              opts.p2pk,
              opts.tags?.map((t) => [...t]),
            );
      const secret = enc.encode(secretStr);
      const { B_, r } = opts.p2pk === undefined ? plain : blindMessage(secret);
      const priv = this.priv[String(a)];
      const pub = this.pub[String(a)];
      if (!priv || !pub) throw new Error(`test-mint: no key for amount ${a}`);
      const sig = createBlindSignature(B_, priv, this.keysetId);
      const dleq = createDLEQProof(B_, priv);
      const C = constructUnblindedSignature(sig, r, secret, pointFromHex(hex(pub))).C;
      out.push({
        id: this.keysetId,
        amount: a,
        secret: secretStr,
        C: C.toHex(true),
        ...(this.nut12
          ? { dleq: { s: hex(dleq.s), e: hex(dleq.e), r: r.toString(16).padStart(64, '0') } }
          : {}),
      });
    }
    return out;
  }

  /** The `RequestFn` to hand to `new Mint(url, { customRequest })`. */
  readonly request: RequestFn = <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    try {
      if (this.failures > 0) {
        this.failures--;
        throw new MintOperationError(99999, 'test mint: simulated outage');
      }
      const url = new URL(args.endpoint);
      const path = url.pathname.replace(/^.*?\/v1\//, '/v1/');
      const method = (args.method ?? 'GET').toUpperCase();
      this.calls.push(`${method} ${path}`);
      const body: Record<string, unknown> = args.requestBody ?? {};
      const result = this.route(method, path, body);
      if (method === 'POST' && this.dropped > 0) {
        this.dropped--;
        throw new Error('test mint: the response was lost after the mint committed');
      }
      // Round-trip through JSON like the wire does (Amount → string → number).
      return Promise.resolve(JSON.parse(JSON.stringify(result)) as T);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };

  private route(method: string, path: string, body: Record<string, unknown>): unknown {
    if (method === 'GET' && path === '/v1/info') return this.info();
    // Like Nutshell and cdk: `/v1/keys` serves the active keysets, `/v1/keys/{id}` any keyset.
    if (method === 'GET' && path === '/v1/keys')
      return { keysets: this.sets.filter((k) => k.active).map((k) => this.keysDto(k)) };
    if (method === 'GET' && path.startsWith('/v1/keys/')) {
      const k = this.keysOf(path.slice('/v1/keys/'.length));
      if (k === undefined) throw new MintOperationError(12001, 'Keyset is not known');
      return { keysets: [this.keysDto(k)] };
    }
    if (method === 'GET' && path === '/v1/keysets')
      return {
        keysets: this.sets.map((k) => ({
          id: k.id,
          unit: 'sat',
          active: k.active,
          input_fee_ppk: this.inputFeePpk,
        })),
      };
    if (method === 'POST' && path === '/v1/swap') return this.swap(body);
    if (method === 'POST' && path === '/v1/checkstate') return this.checkState(body);
    if (method === 'POST' && path === '/v1/mint/quote/bolt11') return this.mintQuote(body);
    if (method === 'GET' && path.startsWith('/v1/mint/quote/bolt11/'))
      return this.mintQuoteState(path.slice('/v1/mint/quote/bolt11/'.length));
    if (method === 'POST' && path === '/v1/mint/bolt11') return this.mintBolt11(body);
    if (method === 'POST' && path === '/v1/melt/quote/bolt11') return this.meltQuote(body);
    if (method === 'GET' && path.startsWith('/v1/melt/quote/bolt11/'))
      return this.meltQuoteState(path.slice('/v1/melt/quote/bolt11/'.length));
    if (method === 'POST' && path === '/v1/melt/bolt11') return this.meltBolt11(body);
    if (method === 'POST' && path === '/v1/restore' && this.nut09) return this.restore(body);
    throw new MintOperationError(404, `test mint: no route ${method} ${path}`);
  }

  private info(): unknown {
    const methods = [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 1_000_000 }];
    return {
      name: 'nutflix test mint',
      pubkey: hex(this.pub['1'] ?? new Uint8Array(33)),
      version: 'test/1',
      contact: [],
      nuts: {
        '4': { methods, disabled: false },
        '5': { methods, disabled: false },
        '7': { supported: true },
        '8': { supported: true },
        '10': { supported: true },
        '11': { supported: true },
        ...(this.nut12 ? { '12': { supported: true } } : {}),
        ...(this.nut09 ? { '9': { supported: true } } : {}),
        ...(this.nut20 ? { '20': { supported: true } } : {}),
        ...(this.nut19 === undefined
          ? {}
          : {
              '19': {
                ttl: this.nut19.ttl,
                cached_endpoints: this.nut19.cachedEndpoints.map((e) => ({ ...e })),
              },
            }),
      },
    };
  }

  private keysDto(k: TestKeyset): unknown {
    const keys: Record<string, string> = {};
    for (const [amount, key] of Object.entries(k.pub)) keys[amount] = hex(key);
    return { id: k.id, unit: 'sat', active: k.active, input_fee_ppk: this.inputFeePpk, keys };
  }

  private y(secret: string): string {
    return hashToCurve(enc.encode(secret)).toHex(true);
  }

  private fee(nInputs: number): number {
    return Math.ceil((nInputs * this.inputFeePpk) / 1000);
  }

  /** Verify inputs (signature, not spent, spending conditions); returns their total. */
  private checkInputs(inputs: unknown): {
    total: number;
    ys: string[];
    witnesses: (string | undefined)[];
  } {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new MintOperationError(11002, 'no inputs');
    let total = 0;
    const ys: string[] = [];
    const witnesses: (string | undefined)[] = [];
    for (const raw of inputs) {
      const p = wireProof(raw);
      const amount = num(p.amount);
      // Inactive keysets still redeem (a rotation retires signing, not the proofs).
      const ks = this.keysOf(p.id);
      if (ks === undefined) throw new MintOperationError(12001, 'Keyset is not known');
      const priv = ks.priv[String(amount)];
      if (!priv) throw new MintOperationError(11005, 'amount has no key');
      const secret = enc.encode(p.secret);
      let ok: boolean;
      try {
        ok = verifyUnblindedSignature({ C: pointFromHex(p.C), secret, id: p.id }, priv);
      } catch {
        ok = false;
      }
      if (!ok) throw new MintOperationError(10003, 'Proof could not be verified');
      // NUT-10/11: a locked secret needs its spending conditions met.
      if (p.secret.startsWith('[')) {
        let res: { success: boolean };
        try {
          res = verifyP2PKSpendingConditions(p);
        } catch {
          res = { success: false };
        }
        if (!res.success) throw new MintOperationError(10003, 'spending conditions not met');
      }
      const y = this.y(p.secret);
      if (this.spent.has(y) || ys.includes(y))
        throw new MintOperationError(11001, 'Token already spent');
      if (this.pendingYs.has(y)) throw new MintOperationError(11002, 'Token is pending');
      ys.push(y);
      witnesses.push(typeof p.witness === 'string' ? p.witness : undefined);
      total += amount;
    }
    return { total, ys, witnesses };
  }

  /** Spend checked inputs, remembering each one's witness. */
  private spend(inputs: { ys: string[]; witnesses: (string | undefined)[] }): void {
    inputs.ys.forEach((y, i) => {
      this.spent.add(y);
      const w = inputs.witnesses[i];
      if (w !== undefined) this.witnesses.set(y, w);
    });
  }

  private sign(outputs: unknown): { signatures: SerializedBlindedSignature[]; total: number } {
    if (!Array.isArray(outputs)) throw new MintOperationError(11002, 'outputs must be a list');
    let total = 0;
    const signatures: SerializedBlindedSignature[] = [];
    const seen = new Set<string>();
    for (const raw of outputs as SerializedBlindedMessage[]) {
      const amount = num(raw.amount);
      const priv = this.priv[String(amount)];
      if (raw.id !== this.keysetId) throw new MintOperationError(12001, 'Keyset is not known');
      if (!priv) throw new MintOperationError(11005, 'amount has no key');
      if (seen.has(raw.B_)) throw new MintOperationError(10002, 'duplicate output');
      if (this.promises.has(raw.B_))
        throw new MintOperationError(10002, 'Blinded message of output already signed');
      seen.add(raw.B_);
      const B_ = pointFromHex(raw.B_);
      const sig = createBlindSignature(B_, priv, this.keysetId);
      const dleq = this.nut12 ? createDLEQProof(B_, priv) : undefined;
      signatures.push({
        id: this.keysetId,
        // A plain JSON number, as on the wire (an `Amount` would serialise as a string).
        amount: amount as unknown as Amount,
        C_: sig.C_.toHex(true),
        ...(dleq === undefined ? {} : { dleq: { s: hex(dleq.s), e: hex(dleq.e) } }),
      });
      total += amount;
    }
    return { signatures, total };
  }

  private swap(body: Record<string, unknown>): unknown {
    const inputs = this.checkInputs(body['inputs']);
    // Balance is checked on the outputs' declared amounts BEFORE anything is signed or spent.
    const outputs = body['outputs'];
    if (!Array.isArray(outputs)) throw new MintOperationError(11002, 'outputs must be a list');
    // Like Nutshell: a swap must produce something (a lone proof worth only its fee is refused,
    // not silently burned — found by the real-mint lane).
    if (outputs.length === 0) throw new MintOperationError(11002, 'no outputs provided');
    const outTotal = (outputs as SerializedBlindedMessage[]).reduce((a, o) => a + num(o.amount), 0);
    if (outTotal + this.fee((body['inputs'] as unknown[]).length) !== inputs.total)
      throw new MintOperationError(11002, 'Transaction is not balanced');
    const { signatures } = this.sign(outputs);
    this.spend(inputs);
    this.remember(outputs as SerializedBlindedMessage[], signatures);
    return { signatures };
  }

  /** Keep what was signed, once the operation that signed it has committed. */
  private remember(
    outputs: readonly SerializedBlindedMessage[],
    signatures: readonly SerializedBlindedSignature[],
  ): void {
    outputs.forEach((o, i) => {
      const sig = signatures[i];
      if (sig !== undefined) this.promises.set(o.B_, sig);
    });
  }

  /** NUT-09: the signatures of those `outputs` this mint has signed (the others are left out). */
  private restore(body: Record<string, unknown>): unknown {
    const outputs = body['outputs'];
    if (!Array.isArray(outputs)) throw new MintOperationError(11002, 'outputs must be a list');
    const outs: SerializedBlindedMessage[] = [];
    const signatures: SerializedBlindedSignature[] = [];
    let signed = 0;
    for (const o of outputs as SerializedBlindedMessage[]) {
      let sig = this.promises.get(o.B_);
      if (sig === undefined && signed < this.signOnRestore && o.id === this.keysetId) {
        signed++;
        // A hostile mint: signs (a 1-sat output) whatever it is asked about under its active
        // keyset (an inactive one no longer signs).
        const one = { ...o, amount: 1 as unknown as Amount };
        sig = this.sign([one]).signatures[0];
        if (sig !== undefined) this.remember([one], [sig]);
      }
      if (sig === undefined) continue;
      outs.push(o);
      signatures.push(sig);
    }
    return { outputs: outs, signatures };
  }

  private checkState(body: Record<string, unknown>): unknown {
    const ys = body['Ys'];
    if (!Array.isArray(ys)) throw new MintOperationError(11002, 'Ys must be a list');
    return {
      states: (ys as string[]).map((Y) => ({
        Y,
        state: this.spent.has(Y) ? 'SPENT' : this.pendingYs.has(Y) ? 'PENDING' : 'UNSPENT',
        witness: this.witnesses.get(Y) ?? null,
      })),
    };
  }

  private mintQuote(body: Record<string, unknown>): unknown {
    const amount = num(body['amount']);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new MintOperationError(11002, 'bad amount');
    const pubkey = body['pubkey'];
    if (
      pubkey !== undefined &&
      (!this.nut20 || typeof pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(pubkey))
    )
      throw new MintOperationError(11002, 'bad or unsupported quote pubkey');
    const quote = `q${String(++this.seq)}`;
    this.quotes.set(
      quote,
      typeof pubkey === 'string'
        ? { amount, state: 'UNPAID', pubkey }
        : { amount, state: 'UNPAID' },
    );
    this.lightning?.register(this.invoice(quote, amount), () => {
      this.payQuote(quote);
    });
    return this.mintQuoteState(quote);
  }

  private mintQuoteState(quote: string): unknown {
    const q = this.quotes.get(quote);
    if (!q) throw new MintOperationError(20007, 'quote not found');
    return {
      quote,
      // bolt11 HRP amounts are in BTC multiples: `n` = 1e-9 BTC = 0.1 sat. The data part must be
      // bech32 (no `1`): the HRP ends at the LAST `1` of the invoice.
      request: this.invoice(quote, q.amount),
      unit: 'sat',
      amount: q.amount,
      state: q.state,
      expiry: this.quoteExpiry,
      ...(q.pubkey === undefined ? {} : { pubkey: q.pubkey }),
    };
  }

  private invoice(quote: string, amount: number): string {
    return `lnbc${String(amount * 10)}n1testmint${this.invoiceTag}${bech32Digits(quote)}`;
  }

  private mintBolt11(body: Record<string, unknown>): unknown {
    const quote = String(body['quote']);
    const q = this.quotes.get(quote);
    if (!q) throw new MintOperationError(20007, 'quote not found');
    if (q.state === 'UNPAID') throw new MintOperationError(20001, 'Quote request is not paid');
    if (q.state === 'ISSUED')
      throw new MintOperationError(20002, 'Tokens have already been issued for quote');
    const outputs = body['outputs'];
    if (!Array.isArray(outputs)) throw new MintOperationError(11002, 'outputs must be a list');
    // Like Nutshell: a swap must produce something (a lone proof worth only its fee is refused,
    // not silently burned — found by the real-mint lane).
    if (outputs.length === 0) throw new MintOperationError(11002, 'no outputs provided');
    const outTotal = (outputs as SerializedBlindedMessage[]).reduce((a, o) => a + num(o.amount), 0);
    if (outTotal !== q.amount) throw new MintOperationError(11002, 'Transaction is not balanced');
    if (q.pubkey !== undefined) {
      const sig = body['signature'];
      const ok =
        typeof sig === 'string' &&
        verifyMintQuoteSignature(q.pubkey, quote, outputs as SerializedBlindedMessage[], sig);
      if (!ok)
        throw new MintOperationError(
          20008,
          'Mint quote with pubkey but no valid signature provided',
        );
    }
    const { signatures } = this.sign(outputs);
    q.state = 'ISSUED';
    this.remember(outputs as SerializedBlindedMessage[], signatures);
    return { signatures };
  }

  private meltQuote(body: Record<string, unknown>): unknown {
    const request = String(body['request']);
    const m = /^lnbc(\d+)n1/.exec(request);
    if (m === null || Number(m[1]) % 10 !== 0)
      throw new MintOperationError(11002, 'not a test invoice (lnbc<10·sats>n1…)');
    const quote = `m${String(++this.seq)}`;
    this.melts.set(quote, { amount: Number(m[1]) / 10, request, state: 'UNPAID' });
    return this.meltQuoteState(quote);
  }

  private meltQuoteState(quote: string, change?: SerializedBlindedSignature[]): unknown {
    const q = this.melts.get(quote);
    if (!q) throw new MintOperationError(20007, 'quote not found');
    return {
      quote,
      amount: q.amount,
      unit: 'sat',
      request: q.request,
      fee_reserve: this.feeReserve,
      state: q.state,
      expiry: 4_102_444_800,
      payment_preimage: q.state === 'PAID' ? '00'.repeat(32) : null,
      ...(change === undefined ? {} : { change }),
    };
  }

  private meltBolt11(body: Record<string, unknown>): unknown {
    const quote = String(body['quote']);
    const q = this.melts.get(quote);
    if (!q) throw new MintOperationError(20007, 'quote not found');
    if (q.state === 'PAID') throw new MintOperationError(20006, 'quote already paid');
    if (q.state === 'PENDING') throw new MintOperationError(20005, 'quote is pending');
    if (this.refuseMelts > 0) {
      this.refuseMelts--;
      throw new MintOperationError(20000, 'test mint: the payment was refused');
    }
    const inputs = this.checkInputs(body['inputs']);
    const need = q.amount + this.feeReserve + this.fee((body['inputs'] as unknown[]).length);
    if (inputs.total < need) throw new MintOperationError(11002, 'Transaction is not balanced');
    // NUT-08: the unused fee reserve comes back as change on the blank outputs, if any.
    const blanks = Array.isArray(body['outputs'])
      ? (body['outputs'] as SerializedBlindedMessage[])
      : [];
    // Like Nutshell and cdk (and the swap here): outputs already signed refuse the melt BEFORE
    // anything is spent or paid (NUT-13 counter collisions on the blanks, ADR 0016 §4).
    const seenBlank = new Set<string>();
    for (const b of blanks) {
      if (this.promises.has(b.B_) || seenBlank.has(b.B_))
        throw new MintOperationError(10002, 'Blinded message of output already signed');
      seenBlank.add(b.B_);
    }
    const refund = inputs.total - q.amount - this.fee((body['inputs'] as unknown[]).length);
    if (this.holdMelts > 0) {
      // The Lightning payment is in flight: PENDING, the inputs held, no change yet.
      this.holdMelts--;
      const paidNow = this.holdLightning === 'now';
      for (const y of inputs.ys) this.pendingYs.add(y);
      this.held.set(quote, { inputs, blanks: [...blanks], refund, paidNow });
      q.state = 'PENDING';
      if (paidNow) this.lightning?.pay(q.request);
      return this.meltQuoteState(quote);
    }
    this.spend(inputs);
    q.state = 'PAID';
    this.lightning?.pay(q.request);
    return this.meltQuoteState(quote, this.signChange(blanks, refund));
  }

  /** NUT-08 change of `refund` sats on `blanks` (remembered: NUT-09 restores it). */
  private signChange(
    blanks: readonly SerializedBlindedMessage[],
    refund: number,
  ): SerializedBlindedSignature[] {
    const change: SerializedBlindedSignature[] = [];
    let left = refund;
    for (const a of denominations(refund).reverse()) {
      const slot = blanks[change.length];
      if (slot === undefined || left <= 0) break;
      const out = { ...slot, amount: a as unknown as Amount };
      const signed = this.sign([out]).signatures;
      this.remember([out], signed);
      change.push(...signed);
      left -= a;
    }
    return change;
  }
}

/** A string's digits re-spelled in the bech32 alphabet (so a fake invoice has no stray `1`). */
function bech32Digits(s: string): string {
  const alphabet = 'qpzry9x8gf';
  return s.replace(/[0-9]/g, (d) => alphabet[Number(d)] ?? 'q');
}

/** Power-of-two denominations, largest first. */
function denominations(amount: number): number[] {
  const out: number[] = [];
  let bit = 1;
  let n = amount;
  while (n > 0) {
    if (n & 1) out.unshift(bit);
    n = Math.floor(n / 2);
    bit *= 2;
  }
  return out;
}
