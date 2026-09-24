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
 * Lightning is simulated: a mint quote is paid with `payQuote()`, a melt quote always pays.
 * Test hooks: `issue()` mints proofs directly (optionally P2PK-locked, with extra NUT-10 tags),
 * `markSpent()` spends proofs behind everyone's back, `failNext()` injects a mint outage.
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
}

interface Quote {
  readonly amount: number;
  state: 'UNPAID' | 'PAID' | 'ISSUED';
}

interface MeltQuote {
  readonly amount: number;
  readonly request: string;
  state: 'UNPAID' | 'PENDING' | 'PAID';
}

export class TestMint {
  readonly url: MintUrl;
  readonly keysetId: string;
  private readonly pub: Readonly<Record<string, Uint8Array>>;
  private readonly priv: Readonly<Record<string, Uint8Array>>;
  private readonly inputFeePpk: number;
  private readonly feeReserve: number;
  /** hex(Y) of every spent proof. */
  private readonly spent = new Set<string>();
  private readonly quotes = new Map<string, Quote>();
  private readonly melts = new Map<string, MeltQuote>();
  private seq = 0;
  private failures = 0;
  /** Requests served, by path — tests assert what the code under test actually did. */
  readonly calls: string[] = [];

  constructor(o: TestMintOptions) {
    this.url = o.url;
    this.inputFeePpk = o.inputFeePpk ?? 0;
    this.feeReserve = o.feeReserve ?? 0;
    const pair = createNewMintKeys(16, o.seed, { unit: 'sat', input_fee_ppk: this.inputFeePpk });
    this.keysetId = pair.keysetId;
    this.pub = pair.pubKeys;
    this.priv = pair.privKeys;
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
        dleq: { s: hex(dleq.s), e: hex(dleq.e), r: r.toString(16).padStart(64, '0') },
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
      // Round-trip through JSON like the wire does (Amount → string → number).
      return Promise.resolve(JSON.parse(JSON.stringify(this.route(method, path, body))) as T);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };

  private route(method: string, path: string, body: Record<string, unknown>): unknown {
    if (method === 'GET' && path === '/v1/info') return this.info();
    if (method === 'GET' && (path === '/v1/keys' || path === `/v1/keys/${this.keysetId}`))
      return { keysets: [this.keysDto()] };
    if (method === 'GET' && path.startsWith('/v1/keys/'))
      throw new MintOperationError(12001, 'Keyset is not known');
    if (method === 'GET' && path === '/v1/keysets')
      return {
        keysets: [
          { id: this.keysetId, unit: 'sat', active: true, input_fee_ppk: this.inputFeePpk },
        ],
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
        '12': { supported: true },
      },
    };
  }

  private keysDto(): unknown {
    const keys: Record<string, string> = {};
    for (const [amount, k] of Object.entries(this.pub)) keys[amount] = hex(k);
    return { id: this.keysetId, unit: 'sat', active: true, input_fee_ppk: this.inputFeePpk, keys };
  }

  private y(secret: string): string {
    return hashToCurve(enc.encode(secret)).toHex(true);
  }

  private fee(nInputs: number): number {
    return Math.ceil((nInputs * this.inputFeePpk) / 1000);
  }

  /** Verify inputs (signature, not spent, spending conditions); returns their total. */
  private checkInputs(inputs: unknown): { total: number; ys: string[] } {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new MintOperationError(11002, 'no inputs');
    let total = 0;
    const ys: string[] = [];
    for (const raw of inputs) {
      const p = wireProof(raw);
      const amount = num(p.amount);
      if (p.id !== this.keysetId) throw new MintOperationError(12001, 'Keyset is not known');
      const priv = this.priv[String(amount)];
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
      ys.push(y);
      total += amount;
    }
    return { total, ys };
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
      seen.add(raw.B_);
      const B_ = pointFromHex(raw.B_);
      const sig = createBlindSignature(B_, priv, this.keysetId);
      const dleq = createDLEQProof(B_, priv);
      signatures.push({
        id: this.keysetId,
        // A plain JSON number, as on the wire (an `Amount` would serialise as a string).
        amount: amount as unknown as Amount,
        C_: sig.C_.toHex(true),
        dleq: { s: hex(dleq.s), e: hex(dleq.e) },
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
    const outTotal = (outputs as SerializedBlindedMessage[]).reduce((a, o) => a + num(o.amount), 0);
    if (outTotal + this.fee((body['inputs'] as unknown[]).length) !== inputs.total)
      throw new MintOperationError(11002, 'Transaction is not balanced');
    const { signatures } = this.sign(outputs);
    for (const y of inputs.ys) this.spent.add(y);
    return { signatures };
  }

  private checkState(body: Record<string, unknown>): unknown {
    const ys = body['Ys'];
    if (!Array.isArray(ys)) throw new MintOperationError(11002, 'Ys must be a list');
    return {
      states: (ys as string[]).map((Y) => ({
        Y,
        state: this.spent.has(Y) ? 'SPENT' : 'UNSPENT',
        witness: null,
      })),
    };
  }

  private mintQuote(body: Record<string, unknown>): unknown {
    const amount = num(body['amount']);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new MintOperationError(11002, 'bad amount');
    const quote = `q${String(++this.seq)}`;
    this.quotes.set(quote, { amount, state: 'UNPAID' });
    return this.mintQuoteState(quote);
  }

  private mintQuoteState(quote: string): unknown {
    const q = this.quotes.get(quote);
    if (!q) throw new MintOperationError(20007, 'quote not found');
    return {
      quote,
      // bolt11 HRP amounts are in BTC multiples: `n` = 1e-9 BTC = 0.1 sat. The data part must be
      // bech32 (no `1`): the HRP ends at the LAST `1` of the invoice.
      request: `lnbc${String(q.amount * 10)}n1testmint${bech32Digits(quote)}`,
      unit: 'sat',
      amount: q.amount,
      state: q.state,
      expiry: 4_102_444_800,
    };
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
    const outTotal = (outputs as SerializedBlindedMessage[]).reduce((a, o) => a + num(o.amount), 0);
    if (outTotal !== q.amount) throw new MintOperationError(11002, 'Transaction is not balanced');
    const { signatures } = this.sign(outputs);
    q.state = 'ISSUED';
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
    const inputs = this.checkInputs(body['inputs']);
    const need = q.amount + this.feeReserve + this.fee((body['inputs'] as unknown[]).length);
    if (inputs.total < need) throw new MintOperationError(11002, 'Transaction is not balanced');
    for (const y of inputs.ys) this.spent.add(y);
    q.state = 'PAID';
    // NUT-08: the unused fee reserve comes back as change on the blank outputs, if any.
    const blanks = Array.isArray(body['outputs'])
      ? (body['outputs'] as SerializedBlindedMessage[])
      : [];
    const refund = inputs.total - q.amount - this.fee((body['inputs'] as unknown[]).length);
    const change: SerializedBlindedSignature[] = [];
    let left = refund;
    for (const a of denominations(refund).reverse()) {
      const slot = blanks[change.length];
      if (slot === undefined || left <= 0) break;
      change.push(...this.sign([{ ...slot, amount: a as unknown as Amount }]).signatures);
      left -= a;
    }
    return this.meltQuoteState(quote, change);
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
