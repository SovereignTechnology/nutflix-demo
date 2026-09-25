/**
 * Security review F33 and issue #8 on the GATEWAY's upstream path: three real upstream `Seeder`s
 * (each holding the whole blob) over directly piped replication streams, `pay/1` bridged by hand
 * between the gateway's and each upstream's fake (as in `upstream-payer.test.ts`), and the gateway
 * reading the blob at full speed through `readUpstreamBlob`.
 *
 * Asserts: every block delivered once and each upstream counted exactly what the gateway got
 * from it — none sent twice, none paid twice; each paid exactly for what it sent; the window-1
 * upstream is never overrun (its outstanding count, read inside its own `recordUpload`, never
 * passes 1) and nobody is cut; the gateway's pool follows the upstreams' windows.
 */
import { mocks } from '@sovit/core';
import type {
  BlockRange,
  CashuP2pkPubkey,
  NostrPubkey,
  PayMessage,
  PeerWindow,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { Seeder, nodeCrypto, nodeFs, toHex } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { FakePayProtocol, helloFrom } from './fake-pay-protocol.js';
import {
  MINT_A,
  basePolicy,
  capturedLogger,
  cleanupRigs,
  pubkey,
  rig,
  tmpDir,
  until,
} from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await cleanupRigs();
});

const UP_BLOCK = 65_536;
const N = 32;
/** 2 sats/block with a 2-sat minimum PAY: every upstream's window is exactly its own. */
const POLICY: PricePolicy = { ...basePolicy(2), mints: [MINT_A], minPaySats: 2 as Sats };

interface Upstream {
  readonly seeder: Seeder;
  readonly engine: mocks.MockPaymentEngine;
  readonly pubkey: NostrPubkey;
  readonly p2pk: CashuP2pkPubkey;
  readonly windowBlocks: number;
}

async function upstream(name: string, windowBlocks: number): Promise<Upstream> {
  const t = await tmpDir('nutflix-f33-up-');
  const pk = pubkey(name);
  const p2pk = `02${toHex(new Uint8Array(32).fill(name.charCodeAt(0)))}` as CashuP2pkPubkey;
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: { windowBlocks, acceptedMints: [MINT_A], ownP2pk: p2pk, ownPubkey: pk },
  });
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 8 * 1024 * 1024,
      blockSize: UP_BLOCK,
      swarm: null,
      policy: POLICY,
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: capturedLogger('error').logger, fs: nodeFs, crypto: nodeCrypto },
  );
  seeder.start();
  cleanups.push(async () => {
    await seeder.close();
    await t.rm();
  });
  return { seeder, engine, pubkey: pk, p2pk, windowBlocks };
}

function pipe(a: Seeder, b: Seeder) {
  const sa = a.replicate(true);
  const sb = b.replicate(false);
  sa.on('error', () => undefined);
  sb.on('error', () => undefined);
  sa.pipe(sb).pipe(sa);
  return { sa, sb };
}

describe('F33 / issue #8 — the gateway reads upstream from three seeders, one per block', () => {
  it('each block delivered and paid once, each upstream paid exactly for what it sent, the window-1 upstream never overrun', async () => {
    // A writes; B and C mirror all of it first (A's window absorbs that unpaid warm-up).
    const ups = [await upstream('a', 64), await upstream('b', 4), await upstream('c', 1)];
    const [a] = ups as [Upstream, Upstream, Upstream];
    const data = new Uint8Array(UP_BLOCK * N).map((_, i) => (i * 13 + 7) % 256);
    const put = await a.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error(put.error.code);
    const core = put.entry.coreKey;
    for (const u of ups.slice(1)) {
      const l = pipe(a.seeder, u.seeder);
      const sc = await u.seeder.blobs.openCoreByKey(Buffer.from(core, 'hex'));
      await (
        sc.core as unknown as {
          download(r: { start: number; end: number }): { done(): Promise<void> };
        }
      )
        .download({ start: 0, end: N })
        .done();
      l.sa.destroy();
      l.sb.destroy();
    }

    const r = await rig({ raw: { upstream: { payEveryBlocks: 2 } } });
    r.gateway.setUpstreamPolicy(core, POLICY);
    const worst = ups.map(() => 0);
    const gwIds: string[] = [];
    for (const [k, u] of ups.entries()) {
      const { sa, sb } = pipe(r.gateway.seeder, u.seeder);
      await until(() => r.protocols.length === k + 1, 5000);
      const gwProto = r.protocols[k]!;
      await sb.noiseStream.opened;
      const gwId = toHex(sa.noiseStream.publicKey!);
      gwIds.push(gwId);
      await until(() => u.seeder.session(gwId) !== undefined, 5000);
      const upProto = new FakePayProtocol();
      u.seeder.attachPayProtocol(u.seeder.session(gwId)!, upProto);
      const send = gwProto.sendPay.bind(gwProto);
      gwProto.sendPay = (msg: PayMessage) => {
        send(msg);
        upProto.remotePay(msg);
      };
      const ack = upProto.sendAck.bind(upProto);
      upProto.sendAck = (x) => {
        ack(x);
        gwProto.remoteAck({ type: 'ACK', ...x });
      };
      // Its outstanding count toward the gateway, read where it decides to cut.
      const record = u.engine.recordUpload.bind(u.engine);
      u.engine.recordUpload = (peer: NostrPubkey, blocks: BlockRange, pricing): PeerWindow => {
        const w = record(peer, blocks, pricing);
        worst[k] = Math.max(worst[k] ?? 0, w.outstanding);
        return w;
      };
      gwProto.remoteHello(
        helloFrom(u.pubkey, {
          acceptedMints: [MINT_A],
          satsPerBlock: 2 as Sats,
          p2pk: u.p2pk,
          windowBlocks: u.windowBlocks,
        }),
      );
    }
    const upNoise = r.sessions.map((s) => s.noiseKeyHex);
    const sc = await r.gateway.openUpstreamCore(core);
    const downloads: { index: number; from: string }[] = [];
    sc.core.on('download', (index, _b, peer) => {
      downloads.push({ index, from: toHex(peer.remotePublicKey) });
    });
    await until(() => sc.core.peers.length === 3, 5000);
    expect(r.gateway.credit.limit).toBe(64 + 4 + 1);

    const chunks: Uint8Array[] = [];
    for await (const b of r.gateway.readUpstreamBlob(core, put.entry.blob, { timeoutMs: 20_000 }))
      chunks.push(b);
    expect(Buffer.compare(Buffer.concat(chunks), Buffer.from(data))).toBe(0);
    await r.gateway.payer.flush();
    await until(() => r.gateway.credit.size === 0, 20_000);

    expect(downloads).toHaveLength(N);
    expect(new Set(downloads.map((d) => d.index)).size).toBe(N);
    let sent = 0;
    for (const [k, u] of ups.entries()) {
      const delivered = downloads.filter((d) => d.from === upNoise[k]).length;
      const w = u.engine.window(gwIds[k] as NostrPubkey);
      expect(w?.uploaded ?? 0, `upstream ${String(k)} sent`).toBe(delivered);
      expect(w?.paid ?? 0, `upstream ${String(k)} paid`).toBe(delivered);
      expect(w?.banned ?? false).toBe(false);
      expect(
        worst[k],
        `upstream ${String(k)} (window ${String(u.windowBlocks)})`,
      ).toBeLessThanOrEqual(u.windowBlocks);
      expect(u.seeder.bans()).toEqual([]);
      sent += w?.uploaded ?? 0;
    }
    expect(sent).toBe(N);
    expect(r.gateway.payer.stats()).toMatchObject({ blocksPaid: N, acksRejected: 0 });
    expect(r.engine.spent().total).toBe(N * POLICY.satsPerBlock);
  });
});
