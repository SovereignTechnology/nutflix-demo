/**
 * LocalSigner: signing, NIP-44, the NUT-11 witness, lock-zeroes-memory, and the refusals.
 */
import { describe, expect, it } from 'vitest';
import { schnorrVerifyMessage, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { nsecEncode } from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';

import type { NostrPubkey } from '../../contracts/index.js';
import { minimumCost, sealKeyFile } from '../keyfile.js';
import { LocalSigner, parseSecretKey } from '../local.js';

const enc = new TextEncoder();
const COST = minimumCost();
const PW = (): Uint8Array => enc.encode('a long enough passphrase');

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function fresh(walletKey?: Uint8Array): Promise<LocalSigner> {
  const { signer } = await LocalSigner.create({
    passphrase: PW(),
    cost: COST,
    ...(walletKey === undefined ? {} : { walletKey }),
  });
  return signer;
}

const TEMPLATE = { kind: 1, created_at: 1_700_000_000, tags: [['t', 'nutflix']], content: 'hello' };

describe('LocalSigner', () => {
  it('create → sign: a verifying NIP-01 event by its own pubkey; unlock of the stored file gives the same key', async () => {
    const { signer, file } = await LocalSigner.create({ passphrase: PW(), cost: COST });
    const pk = await signer.getPublicKey();
    expect(LocalSigner.pubkeyOf(file)).toBe(pk);
    const ev = await signer.signEvent(TEMPLATE);
    expect(ev.pubkey).toBe(pk);
    expect(verifyEvent({ ...ev, tags: ev.tags.map((t) => [...t]) })).toBe(true);
    expect(Object.isFrozen(ev)).toBe(true);
    const again = await LocalSigner.unlock(file, PW());
    expect(await again.getPublicKey()).toBe(pk);
  });

  it('imports an nsec or hex key and seals it; the file names the imported pubkey', async () => {
    const sk = new Uint8Array(32).fill(5);
    const want = getPublicKey(sk);
    for (const text of [nsecEncode(sk), hex(sk), `  ${hex(sk).toUpperCase()}  `]) {
      const parsed = parseSecretKey(enc.encode(text));
      expect(hex(parsed)).toBe(hex(sk));
      const { signer, file } = await LocalSigner.create({
        passphrase: PW(),
        secretKey: parsed,
        cost: COST,
      });
      expect(await signer.getPublicKey()).toBe(want);
      expect(LocalSigner.pubkeyOf(file)).toBe(want);
    }
    for (const bad of ['nsec1notvalid', 'npub1xyz', 'zz'.repeat(32), '', 'ab'.repeat(31)])
      expect(() => parseSecretKey(enc.encode(bad)), bad).toThrow(/invalid-argument/);
    // Zero is not a secp256k1 secret key.
    await expect(
      LocalSigner.create({ passphrase: PW(), secretKey: new Uint8Array(32), cost: COST }),
    ).rejects.toThrow(/invalid-argument/);
  });

  it('refuses to sign malformed input or an event naming another pubkey', async () => {
    const s = await fresh();
    const bad: unknown[] = [
      { ...TEMPLATE, kind: -1 },
      { ...TEMPLATE, kind: 70_000 },
      { ...TEMPLATE, kind: 1.5 },
      { ...TEMPLATE, created_at: -5 },
      { ...TEMPLATE, content: 7 },
      { ...TEMPLATE, tags: [[]] },
      { ...TEMPLATE, tags: [['t', 3]] },
      { ...TEMPLATE, tags: 'x' },
      { ...TEMPLATE, pubkey: 'ab'.repeat(32) },
      null,
    ];
    for (const b of bad)
      await expect(s.signEvent(b as never), JSON.stringify(b)).rejects.toThrow(/invalid-argument/);
  });

  it('NIP-44 interoperates with nostr-tools both ways and refuses a bad peer key', async () => {
    const s = await fresh();
    const me = await s.getPublicKey();
    const peerSk = new Uint8Array(32).fill(3);
    const peer = getPublicKey(peerSk) as NostrPubkey;
    const ct = await s.nip44Encrypt(peer, 'secret wallet state');
    expect(nip44.decrypt(ct, nip44.getConversationKey(peerSk, me))).toBe('secret wallet state');
    const back = nip44.encrypt('reply', nip44.getConversationKey(peerSk, me));
    expect(await s.nip44Decrypt(peer, back)).toBe('reply');
    await expect(s.nip44Decrypt(peer, 'garbage')).rejects.toThrow(/could not decrypt/);
    await expect(s.nip44Encrypt('nothex' as NostrPubkey, 'x')).rejects.toThrow(/invalid-argument/);
  });

  it('signSecret (NUT-11 witness) is BIP-340 over SHA-256(secret) with the WALLET key, verifiable by cashu-ts; absent without a wallet key', async () => {
    const wk = new Uint8Array(32).fill(11);
    const walletPub = Buffer.from(getPubKeyFromPrivKey(wk)).toString('hex');
    const s = await fresh(wk);
    expect(s.signSecret).toBeDefined();
    const secret = JSON.stringify(['P2PK', { nonce: 'ab', data: walletPub }]);
    const sig = await s.signSecret!(secret);
    expect(schnorrVerifyMessage(sig, secret, walletPub)).toBe(true);
    // Not the Nostr key.
    expect(schnorrVerifyMessage(sig, secret, `02${await s.getPublicKey()}`)).toBe(false);
    await expect(s.signSecret!('')).rejects.toThrow(/invalid-argument/);
    expect((await fresh()).signSecret).toBeUndefined();
  });

  it('lock() zeroes the key buffers in place and every operation afterwards is `signer-locked`', async () => {
    const wk = new Uint8Array(32).fill(13);
    const s = await fresh(wk);
    const inner = s as unknown as { sk: Uint8Array | null; walletKey: Uint8Array | null };
    const sk = inner.sk!;
    const w = inner.walletKey!;
    expect(sk.some((b) => b !== 0)).toBe(true);
    await s.lock();
    expect(s.isLocked()).toBe(true);
    expect(sk.every((b) => b === 0)).toBe(true);
    expect(w.every((b) => b === 0)).toBe(true);
    for (const p of [
      s.getPublicKey(),
      s.signEvent(TEMPLATE),
      s.nip44Encrypt('ab'.repeat(32) as NostrPubkey, 'x'),
      s.nip44Decrypt('ab'.repeat(32) as NostrPubkey, 'x'),
      s.signSecret!('x'),
    ])
      await expect(p).rejects.toThrow(/signer-locked/);
    await s.lock(); // idempotent
  });

  it('a key file whose header names a different pubkey than its key is refused at unlock (`bad-key`)', async () => {
    const sk = new Uint8Array(32).fill(21);
    const other = getPublicKey(new Uint8Array(32).fill(22));
    const file = await sealKeyFile({ secretKey: sk, pubkey: other, passphrase: PW(), cost: COST });
    await expect(LocalSigner.unlock(file, PW())).rejects.toThrow(/bad-key/);
  });

  it('error messages never carry key material', async () => {
    const s = await fresh(new Uint8Array(32).fill(17));
    const inner = s as unknown as { sk: Uint8Array };
    const skHex = hex(inner.sk);
    const errors: string[] = [];
    for (const p of [
      s.signEvent({ ...TEMPLATE, pubkey: 'ab'.repeat(32) as NostrPubkey }),
      s.nip44Decrypt('ab'.repeat(32) as NostrPubkey, 'AAAA'),
      s.nip44Encrypt('xyz' as NostrPubkey, 'x'),
    ]) {
      try {
        await p;
      } catch (e) {
        errors.push(String(e));
      }
    }
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).not.toContain(skHex);
  });
});
