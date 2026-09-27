/**
 * PayChannel + the connection-bound HELLO over an in-memory mux pair (the protomux surface the
 * channel uses). Adversary cases: a HELLO replayed onto another connection, a HELLO reflected
 * back to its sender, a forged signature, a second HELLO naming another pubkey, an undecodable
 * frame, junk terms; plus the `cut` contract (synchronous hook, stream destroyed, one close).
 */
import { describe, expect, it } from 'vitest';

import type {
  AckMessage,
  CashuP2pkPubkey,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  MuxLike,
  OwedMessage,
  PayMessage,
  PriceMessage,
  Sats,
} from '../../contracts/index.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import { PayChannel } from '../channel.js';
import { payCodec } from '../codec.js';
import {
  bindingFromMux,
  buildHello,
  helloChallenge,
  verifyHello,
  type ConnectionBinding,
} from '../hello.js';

const CORE = 'c0'.repeat(32) as CoreKeyHex;
const TERMS = {
  acceptedMints: ['https://mint.example'] as MintUrl[],
  satsPerBlock: 2 as Sats,
  split: { seeder: 50, creator: 50 },
  p2pk: ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey,
  windowBlocks: 4,
};

/** Two protomux-like ends joined in memory; frames are copied, delivered on a microtask. */
function muxPair(hh = new Uint8Array(32).fill(7)): {
  a: MuxLike & { stream: { destroyed: boolean; destroy(): void } };
  b: MuxLike & { stream: { destroyed: boolean; destroy(): void } };
  inject(to: 'a' | 'b', frame: Uint8Array): void;
  bindA: ConnectionBinding;
  bindB: ConnectionBinding;
} {
  const keyA = new Uint8Array(32).fill(1);
  const keyB = new Uint8Array(32).fill(2);
  interface End {
    onmessage?: ((m: Uint8Array) => void) | undefined;
    onclose?: (() => void) | undefined;
    peer?: End;
  }
  const ends: Record<'a' | 'b', End> = { a: {}, b: {} };
  ends.a.peer = ends.b;
  ends.b.peer = ends.a;
  const make = (name: 'a' | 'b', local: Uint8Array, remote: Uint8Array) => {
    const stream = {
      handshakeHash: hh,
      publicKey: local,
      remotePublicKey: remote,
      destroyed: false,
      destroy(): void {
        stream.destroyed = true;
      },
    };
    return {
      stream,
      createChannel(opts: { onclose?: () => void }): unknown {
        ends[name].onclose = opts.onclose;
        return {
          addMessage(m: { onmessage: (b: Uint8Array) => void }) {
            ends[name].onmessage = m.onmessage;
            return {
              send(buf: Uint8Array): boolean {
                const copy = Uint8Array.from(buf);
                const to = ends[name].peer;
                queueMicrotask(() => to?.onmessage?.(copy));
                return true;
              },
            };
          },
          open(): void {
            // the in-memory pair is open from the start
          },
          close(): void {
            const to = ends[name].peer;
            queueMicrotask(() => to?.onclose?.());
          },
        };
      },
    };
  };
  return {
    a: make('a', keyA, keyB),
    b: make('b', keyB, keyA),
    inject: (to, frame) => ends[to].onmessage?.(frame),
    bindA: { handshakeHash: hh, localNoiseKey: keyA, remoteNoiseKey: keyB },
    bindB: { handshakeHash: hh, localNoiseKey: keyB, remoteNoiseKey: keyA },
  };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function signer(): Promise<LocalSigner> {
  return (
    await LocalSigner.create({
      passphrase: new TextEncoder().encode('pw pw pw pw'),
      cost: minimumCost(),
    })
  ).signer;
}

/** The refusal reason of a HELLO verdict (`''` for an accepted HELLO, so `toMatch` fails). */
function reasonOf(v: ReturnType<typeof verifyHello>): string {
  return v.ok ? '' : v.reason;
}

describe('pay/1 HELLO (connection-bound, ADR 0010 §7)', () => {
  it('builds a HELLO that verifies on the other end of the SAME connection only', async () => {
    const s = await signer();
    const p = muxPair();
    const h = await buildHello(s, p.bindA, TERMS);
    const msg: HelloMessage = { type: 'HELLO', ...h };
    expect(msg.challenge).toBe(helloChallenge(p.bindA.handshakeHash, p.bindA.localNoiseKey));
    expect(verifyHello(msg, p.bindB)).toEqual({ ok: true });
    // Replayed onto another connection (another handshake hash).
    const other = muxPair(new Uint8Array(32).fill(8));
    expect(reasonOf(verifyHello(msg, other.bindB))).toMatch(/not bound/);
    // Reflected back to its sender (A receives its own HELLO: the sender key is A, not the remote).
    expect(reasonOf(verifyHello(msg, p.bindA))).toMatch(/not bound/);
    // Forged signature / another pubkey claiming it.
    expect(reasonOf(verifyHello({ ...msg, signature: '00'.repeat(64) }, p.bindB))).toMatch(
      /signature/,
    );
    expect(reasonOf(verifyHello({ ...msg, pubkey: 'ab'.repeat(32) as never }, p.bindB))).toMatch(
      /signature/,
    );
    expect(
      reasonOf(verifyHello({ ...msg, createdAt: (msg.createdAt + 1) as never }, p.bindB)),
    ).toMatch(/signature/);
  });

  it('refuses junk terms (version, mints, split, P2PK, window)', async () => {
    const s = await signer();
    const p = muxPair();
    const msg: HelloMessage = { type: 'HELLO', ...(await buildHello(s, p.bindA, TERMS)) };
    for (const bad of [
      { version: 2 },
      { acceptedMints: ['javascript:alert(1)'] },
      { acceptedMints: Array.from({ length: 17 }, (_, i) => `https://m${String(i)}.example`) },
      { split: { seeder: 60, creator: 60 } },
      { p2pk: 'ab'.repeat(32) },
      { windowBlocks: 70_000 },
      { satsPerBlock: -1 },
    ])
      expect(verifyHello({ ...msg, ...bad } as HelloMessage, p.bindB).ok, JSON.stringify(bad)).toBe(
        false,
      );
    await expect(
      buildHello(s, p.bindA, { ...TERMS, split: { seeder: 1, creator: 1 } }),
    ).rejects.toThrow(/invalid-argument/);
  });

  it('bindingFromMux reads a Noise stream’s handshake; anything less is null', () => {
    const p = muxPair();
    expect(bindingFromMux(p.a)).toEqual(p.bindA);
    expect(bindingFromMux({ stream: { handshakeHash: new Uint8Array(32) } })).toBeNull();
    expect(bindingFromMux(null)).toBeNull();
  });
});

describe('PayChannel', () => {
  async function opened(): Promise<{
    a: PayChannel;
    b: PayChannel;
    p: ReturnType<typeof muxPair>;
    sa: LocalSigner;
    sb: LocalSigner;
  }> {
    const p = muxPair();
    const [sa, sb] = [await signer(), await signer()];
    const a = new PayChannel();
    const b = new PayChannel();
    a.attach(p.a);
    b.attach(p.b);
    a.sendHello(await buildHello(sa, p.bindA, TERMS));
    b.sendHello(await buildHello(sb, p.bindB, TERMS));
    await tick();
    return { a, b, p, sa, sb };
  }

  it('opens once both verified HELLOs are exchanged; peer is the verified remote HELLO', async () => {
    const { a, b, sa, sb } = await opened();
    expect(a.state).toBe('open');
    expect(b.state).toBe('open');
    expect(a.peer?.pubkey).toBe(await sb.getPublicKey());
    expect(b.peer?.pubkey).toBe(await sa.getPublicKey());
  });

  it('delivers PAY / ACK / PRICE, and a PAY that races its sender’s HELLO is not dropped', async () => {
    const p = muxPair();
    const a = new PayChannel();
    const b = new PayChannel();
    a.attach(p.a);
    b.attach(p.b);
    const got: string[] = [];
    b.on('pay', (m) => got.push(`pay:${String(m.range.fromBlock)}`));
    a.on('ack', (m) => got.push(`ack:${String(m.ok)}`));
    a.on('price', (m) => got.push(`price:${String(m.satsPerBlock)}`));
    const pay: PayMessage = {
      range: { core: CORE, fromBlock: 3, toBlock: 3 },
      carryIn: 0,
      seederProofs: {
        mint: TERMS.acceptedMints[0]!,
        unit: 'sat',
        lockedTo: TERMS.p2pk,
        proofs: [],
      },
      creatorProofs: {
        mint: TERMS.acceptedMints[0]!,
        unit: 'sat',
        lockedTo: TERMS.p2pk,
        proofs: [],
      },
    };
    a.sendPay(pay); // before any HELLO
    b.sendAck({ core: CORE, fromBlock: 3, toBlock: 3, ok: true } satisfies Omit<
      AckMessage,
      'type'
    >);
    b.sendPrice({ core: CORE, satsPerBlock: 5 as Sats, effectiveFromBlock: 9 } satisfies Omit<
      PriceMessage,
      'type'
    >);
    await tick();
    expect(got.sort()).toEqual(['ack:true', 'pay:3', 'price:5']);
  });

  it('an undecodable frame, a replayed HELLO and a second HELLO naming another pubkey are protocol errors', async () => {
    const closes: string[] = [];
    // (1) garbage
    const g = muxPair();
    const ga = new PayChannel({ onProtocolError: (why) => closes.push(why) });
    ga.attach(g.a);
    ga.on('close', (r) => closes.push(`close:${r}`));
    g.inject('a', new Uint8Array([9, 9, 9]));
    expect(ga.state).toBe('closed');
    // (2) a HELLO signed for another connection
    const s = await signer();
    const other = muxPair(new Uint8Array(32).fill(3));
    const foreign = payCodec.encode({
      type: 'HELLO',
      ...(await buildHello(s, other.bindB, TERMS)),
    });
    const r = muxPair();
    const ra = new PayChannel();
    ra.attach(r.a);
    let rclose = '';
    ra.on('close', (x) => (rclose = x));
    r.inject('a', foreign);
    expect(rclose).toBe('protocol-error');
    // (3) two HELLOs, two pubkeys, same connection
    const t = muxPair();
    const ta = new PayChannel();
    ta.attach(t.a);
    let tclose = '';
    ta.on('close', (x) => (tclose = x));
    t.inject('a', payCodec.encode({ type: 'HELLO', ...(await buildHello(s, t.bindB, TERMS)) }));
    expect(ta.peer).not.toBeNull();
    t.inject(
      'a',
      payCodec.encode({ type: 'HELLO', ...(await buildHello(await signer(), t.bindB, TERMS)) }),
    );
    expect(tclose).toBe('protocol-error');
    expect(closes).toContain('close:protocol-error');
    expect(closes.some((c) => c.includes('undecodable'))).toBe(true);
  });

  // Stage 2 pre-push review (missed before: only a second HELLO under ANOTHER pubkey was tested).
  // The same pubkey re-HELLOing with a higher price or another P2PK would replace `peer` — the
  // terms a consumer read at `open` would silently stop being the channel's terms.
  it('a second HELLO from the same pubkey is ignored if identical and a protocol error if it changes the terms', async () => {
    const s = await signer();
    const t = muxPair();
    const ta = new PayChannel();
    ta.attach(t.a);
    let tclose = '';
    ta.on('close', (x) => (tclose = x));
    const first = payCodec.encode({ type: 'HELLO', ...(await buildHello(s, t.bindB, TERMS)) });
    t.inject('a', first);
    t.inject('a', first); // an identical re-send changes nothing
    expect(tclose).toBe('');
    expect(ta.peer?.satsPerBlock).toBe(TERMS.satsPerBlock);
    const pricier = payCodec.encode({
      type: 'HELLO',
      ...(await buildHello(s, t.bindB, { ...TERMS, satsPerBlock: 2000 as Sats })),
    });
    t.inject('a', pricier);
    expect(tclose).toBe('protocol-error');
    expect(ta.peer?.satsPerBlock).toBe(TERMS.satsPerBlock);
  });

  it('cut(): the owner hook runs synchronously, the stream is destroyed, close fires once, later sends are dropped', async () => {
    const { a, p } = await opened();
    const events: string[] = [];
    const cutter = new PayChannel({ onCut: (r) => events.push(`hook:${r}`) });
    const q = muxPair();
    cutter.attach(q.a);
    cutter.on('close', (r) => events.push(`close:${r}`));
    cutter.cut('window-exceeded');
    expect(events).toEqual(['hook:window-exceeded', 'close:window-exceeded']);
    expect(q.a.stream.destroyed).toBe(true);
    cutter.cut('banned');
    expect(events).toHaveLength(2);
    cutter.sendAck({ core: CORE, fromBlock: 0, toBlock: 0, ok: true });
    // A channel with destroyOnCut:false leaves the stream to its owner.
    const keep = new PayChannel({ destroyOnCut: false });
    const k = muxPair();
    keep.attach(k.a);
    keep.cut('local');
    expect(k.a.stream.destroyed).toBe(false);
    expect(a.state).toBe('open');
    expect(p.a.stream.destroyed).toBe(false);
  });

  // v6 amendment (ADR 0018): the seeder's OWED report, and the v6 PRICE / ACK fields end to end.
  it('OWED is delivered once the channel is open; PRICE.free and ACK.outstanding cross intact', async () => {
    const { a, b } = await opened();
    const owed: OwedMessage[] = [];
    const prices: PriceMessage[] = [];
    const acks: AckMessage[] = [];
    b.on('owed', (m) => owed.push(m));
    b.on('price', (m) => prices.push(m));
    b.on('ack', (m) => acks.push(m));
    a.sendPrice({ core: CORE, satsPerBlock: 0 as Sats, effectiveFromBlock: 0, free: true });
    a.sendOwed({
      core: CORE,
      ranges: [
        [0, 3],
        [7, 7],
      ],
    });
    a.sendAck({ core: CORE, fromBlock: 0, toBlock: 3, ok: true, outstanding: 1 });
    await tick();
    expect(prices).toEqual([
      { type: 'PRICE', core: CORE, satsPerBlock: 0, effectiveFromBlock: 0, free: true },
    ]);
    expect(owed).toEqual([
      {
        type: 'OWED',
        core: CORE,
        ranges: [
          [0, 3],
          [7, 7],
        ],
      },
    ]);
    expect(acks).toEqual([
      { type: 'ACK', core: CORE, fromBlock: 0, toBlock: 3, ok: true, outstanding: 1 },
    ]);
    expect(b.state).toBe('open');
  });

  it('an OWED before both HELLOs is a protocol error (no pubkey is bound for it yet)', async () => {
    const whys: string[] = [];
    const p = muxPair();
    const a = new PayChannel({ onProtocolError: (why) => whys.push(why) });
    a.attach(p.a);
    const owed: OwedMessage[] = [];
    let closed = '';
    a.on('owed', (m) => owed.push(m));
    a.on('close', (r) => (closed = r));
    const frame = payCodec.encode({ type: 'OWED', core: CORE, ranges: [[0, 0]] });
    p.inject('a', frame); // idle: no HELLO either way
    expect(owed).toEqual([]);
    expect(closed).toBe('protocol-error');
    expect(whys).toEqual(['OWED before both HELLOs']);
    // Half-open (the remote's HELLO verified, ours not sent): still refused.
    const s = await signer();
    const q = muxPair();
    const half = new PayChannel();
    half.attach(q.a);
    let halfClosed = '';
    half.on('close', (r) => (halfClosed = r));
    q.inject('a', payCodec.encode({ type: 'HELLO', ...(await buildHello(s, q.bindB, TERMS)) }));
    expect(half.peer).not.toBeNull();
    expect(half.state).toBe('idle');
    q.inject('a', frame);
    expect(halfClosed).toBe('protocol-error');
  });

  it('sendHello refuses a HELLO signed for another connection; a remote channel close is `remote`', async () => {
    const s = await signer();
    const p = muxPair();
    const a = new PayChannel();
    a.attach(p.a);
    const wrong = await buildHello(s, muxPair(new Uint8Array(32).fill(4)).bindA, TERMS);
    expect(() => {
      a.sendHello(wrong);
    }).toThrow(/not signed for this connection/);
    const b = new PayChannel();
    b.attach(p.b);
    let reason = '';
    b.on('close', (r) => (reason = r));
    a.cut('local');
    await tick();
    expect(reason).toBe('remote');
  });
});
