/**
 * The NIP-60 wallet event (kind 17375) and kind 10019: a new wallet key is made, sealed to the
 * user and published once; later opens read it back; the key signs witnesses the mint accepts
 * (verified with cashu-ts); a signer holding the same key signs itself; forged, undecryptable
 * and Nostr-key wallets are refused; nothing in the published event is readable without the key.
 */
import { getPubKeyFromPrivKey, schnorrVerifyMessage } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import type { MintUrl, NostrEvent, NostrFilter, RelayUrl } from '../../contracts/index.js';
import { NostrKind } from '../../contracts/index.js';
import { parseNutzapInfo } from '../../nostr/nutzap-info.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import type { Nip60Relays } from '../nip60.js';
import { openNip60Wallet, publishNutzapInfo } from '../nip60-wallet.js';

const MINT = 'https://mint.nip60w.example' as MintUrl;
const MINT_B = 'https://mint-b.nip60w.example' as MintUrl;

function relay(): Nip60Relays & { events: NostrEvent[] } {
  const r = {
    events: [] as NostrEvent[],
    publish: (e: NostrEvent) => {
      r.events.push(e);
      return Promise.resolve();
    },
    query: (f: NostrFilter) =>
      Promise.resolve(
        r.events.filter(
          (e) =>
            (f.kinds === undefined || f.kinds.includes(e.kind)) &&
            (f.authors === undefined || f.authors.includes(e.pubkey)),
        ),
      ),
  };
  return r;
}

async function signer(walletKey?: Uint8Array): Promise<LocalSigner> {
  return (
    await LocalSigner.create({
      passphrase: new TextEncoder().encode('nip60 wallet test'),
      cost: minimumCost(),
      ...(walletKey === undefined ? {} : { walletKey }),
    })
  ).signer;
}

const P2PK_SECRET = (p2pk: string): string =>
  JSON.stringify(['P2PK', { nonce: 'ab'.repeat(16), data: p2pk }]);

describe('openNip60Wallet', () => {
  it('makes a wallet key once, sealed to the user; later opens read the same key; witnesses verify', async () => {
    const s = await signer();
    const r = relay();
    // No wallet yet: nothing is created unless asked (a miss may be unreachable relays).
    await expect(openNip60Wallet({ signer: s, relays: r, defaultMints: [MINT] })).rejects.toThrow(
      /no-wallet:/,
    );
    expect(r.events).toEqual([]);
    const first = await openNip60Wallet({
      signer: s,
      relays: r,
      defaultMints: [MINT, MINT],
      create: true,
    });
    expect(first.created).toBe(true);
    expect(first.mode).toBe('memory');
    expect(first.mints).toEqual([MINT]);
    expect(first.p2pk).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(first.p2pk.slice(2)).not.toBe(await s.getPublicKey());
    const ev = r.events.find((e) => e.kind === NostrKind.WalletInfo)!;
    expect(ev.pubkey).toBe(await s.getPublicKey());
    expect(ev.content).not.toContain('privkey'); // NIP-44 sealed
    expect(ev.content).not.toContain(MINT);

    const again = await openNip60Wallet({ signer: s, relays: r, defaultMints: [MINT_B] });
    expect(again.created).toBe(false);
    expect(again.p2pk).toBe(first.p2pk);
    expect(again.mints).toEqual([MINT]); // an existing wallet keeps its own mints
    expect(r.events.filter((e) => e.kind === NostrKind.WalletInfo)).toHaveLength(1);

    const secret = P2PK_SECRET(again.p2pk);
    expect(schnorrVerifyMessage(await again.key.sign(secret), secret, again.p2pk)).toBe(true);
    first.close();
    again.close();
    again.close(); // idempotent
  });

  it('a signer that holds the same wallet key signs itself (mode signer); nothing kept in memory', async () => {
    const wk = new Uint8Array(32).fill(0x2b);
    const p2pk = Buffer.from(getPubKeyFromPrivKey(wk)).toString('hex');
    const s = await signer(wk);
    const r = relay();
    // The 17375 names the same key the signer holds.
    r.events.push(
      await s.signEvent({
        kind: NostrKind.WalletInfo,
        created_at: 1_700_000_000,
        tags: [],
        content: await s.nip44Encrypt(
          await s.getPublicKey(),
          JSON.stringify([
            ['privkey', Buffer.from(wk).toString('hex')],
            ['mint', MINT],
          ]),
        ),
      }),
    );
    const w = await openNip60Wallet({ signer: s, relays: r, defaultMints: [] });
    expect(w.mode).toBe('signer');
    expect(w.p2pk).toBe(p2pk);
    const secret = P2PK_SECRET(p2pk);
    expect(schnorrVerifyMessage(await w.key.sign(secret), secret, p2pk)).toBe(true);
  });

  it('refuses a 17375 it cannot trust: forged by someone else, undecryptable, keyless, or the Nostr key itself', async () => {
    const me = await signer();
    const mallory = await signer();
    const pub = await me.getPublicKey();

    // A 17375 by Mallory, relabelled as ours: its signature fails, it is ignored → a new key is made.
    const r1 = relay();
    const forged = await mallory.signEvent({
      kind: NostrKind.WalletInfo,
      created_at: 1_700_000_000,
      tags: [],
      content: await mallory.nip44Encrypt(pub, JSON.stringify([['privkey', '11'.repeat(32)]])),
    });
    r1.events.push({ ...forged, pubkey: pub });
    const w1 = await openNip60Wallet({
      signer: me,
      relays: r1,
      defaultMints: [MINT],
      create: true,
    });
    expect(w1.created).toBe(true);
    expect(w1.p2pk).not.toBe(
      Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x11))).toString('hex'),
    );

    const sealed = async (rows: unknown, content?: string): Promise<Nip60Relays> => {
      const r = relay();
      r.events.push(
        await me.signEvent({
          kind: NostrKind.WalletInfo,
          created_at: 1_700_000_000,
          tags: [],
          content: content ?? (await me.nip44Encrypt(pub, JSON.stringify(rows))),
        }),
      );
      return r;
    };
    // Sealed to someone else (does not decrypt with our key).
    const other = await sealed(null, await me.nip44Encrypt(await mallory.getPublicKey(), 'x'));
    await expect(openNip60Wallet({ signer: me, relays: other, defaultMints: [] })).rejects.toThrow(
      /wallet-unreadable: .*does not decrypt/,
    );
    // No privkey row.
    await expect(
      openNip60Wallet({ signer: me, relays: await sealed([['mint', MINT]]), defaultMints: [] }),
    ).rejects.toThrow(/carries no wallet key/);
    // Error messages never carry a key.
    const err = await openNip60Wallet({
      signer: me,
      relays: await sealed([['privkey', 'zz']]),
      defaultMints: [],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/carries no wallet key/);
    expect(err!.message).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('publishNutzapInfo', () => {
  it('a kind 10019 naming the relays, mints and the wallet P2PK key, parseable by the NIP-61 reader', async () => {
    const s = await signer();
    const r = relay();
    const w = await openNip60Wallet({ signer: s, relays: r, defaultMints: [MINT], create: true });
    const ev = await publishNutzapInfo({
      signer: s,
      relays: r,
      readRelays: ['wss://relay.nip60w.example' as RelayUrl],
      mints: w.mints,
      p2pk: w.p2pk,
    });
    expect(parseNutzapInfo(ev)).toMatchObject({
      pubkey: await s.getPublicKey(),
      p2pk: w.p2pk,
      mints: [{ url: MINT, units: ['sat'] }],
      relays: ['wss://relay.nip60w.example'],
    });
    w.close();
  });
});
