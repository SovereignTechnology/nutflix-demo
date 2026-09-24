/**
 * The local signer's key file (argon2id + XChaCha20-Poly1305, header as associated data).
 * Adversary cases: wrong passphrase, every header field tampered, KDF downgrade, a crafted
 * file asking for absurd KDF cost, malformed files, and no key bytes in the sealed output.
 * Tests use the INTERACTIVE floor so each unlock is ~60 ms.
 */
import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';

import {
  KeyFileError,
  MAX_MEM_BYTES,
  minimumCost,
  openKeyFile,
  readKeyFileHeader,
  sealKeyFile,
} from '../keyfile.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SK = new Uint8Array(32).fill(7);
const WK = new Uint8Array(32).fill(9);
const PUB = getPublicKey(SK);
const PW = (): Uint8Array => enc.encode('correct horse battery staple');
const COST = minimumCost();

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function sealed(withWallet = false): Promise<Uint8Array> {
  return sealKeyFile({
    secretKey: SK,
    ...(withWallet ? { walletKey: WK } : {}),
    pubkey: PUB,
    passphrase: PW(),
    cost: COST,
  });
}

function edit(file: Uint8Array, f: (o: Record<string, unknown>) => void): Uint8Array {
  const o = JSON.parse(dec.decode(file)) as Record<string, unknown>;
  f(o);
  return enc.encode(JSON.stringify(o));
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof KeyFileError ? e.code : `other:${String(e)}`;
  }
}

describe('key file', () => {
  it('round-trips the secret key (and the wallet key) under the passphrase', async () => {
    const f = await sealed();
    const a = await openKeyFile(f, PW());
    expect(Array.from(a.secretKey)).toEqual(Array.from(SK));
    expect(a.walletKey).toBeUndefined();
    expect(a.header.pubkey).toBe(PUB);
    const g = await sealed(true);
    const b = await openKeyFile(g, PW());
    expect(Array.from(b.walletKey!)).toEqual(Array.from(WK));
  });

  it('exposes the public header without the passphrase; the file carries no key bytes', async () => {
    const f = await sealed(true);
    const h = readKeyFileHeader(f);
    expect(h).toMatchObject({ v: 1, kind: 'nutflix-local-signer', pubkey: PUB, walletKey: true });
    const text = dec.decode(f);
    expect(text).not.toContain(hex(SK));
    expect(text).not.toContain(hex(WK));
    // Two seals of the same key differ (fresh salt and nonce).
    expect(dec.decode(await sealed(true))).not.toBe(text);
  });

  it('a wrong passphrase is `bad-passphrase` (and so is a damaged ciphertext — indistinguishable on purpose)', async () => {
    const f = await sealed();
    expect(await code(openKeyFile(f, enc.encode('Correct horse battery staple')))).toBe(
      'bad-passphrase',
    );
    const flipped = edit(f, (o) => {
      const ct = o['ct'] as string;
      o['ct'] = (ct.startsWith('0') ? '1' : '0') + ct.slice(1);
    });
    expect(await code(openKeyFile(flipped, PW()))).toBe('bad-passphrase');
  });

  it('every header field is bound by the AEAD: swapping salt, nonce, pubkey, the wallet flag or a raised cost fails to open', async () => {
    const f = await sealed();
    const other = await sealed(); // same key, different salt/nonce
    const o2 = JSON.parse(dec.decode(other)) as { kdf: { salt: string }; aead: { nonce: string } };
    const tampered: Uint8Array[] = [
      edit(f, (o) => {
        (o['kdf'] as { salt: string }).salt = o2.kdf.salt;
      }),
      edit(f, (o) => {
        (o['aead'] as { nonce: string }).nonce = o2.aead.nonce;
      }),
      edit(f, (o) => {
        o['pubkey'] = getPublicKey(new Uint8Array(32).fill(8));
      }),
      edit(f, (o) => {
        (o['kdf'] as { ops: number }).ops = COST.ops + 1;
      }),
    ];
    for (const t of tampered) expect(await code(openKeyFile(t, PW()))).toBe('bad-passphrase');
    // Flipping the wallet flag also changes the expected ciphertext length → malformed.
    const flag = edit(f, (o) => {
      o['walletKey'] = true;
    });
    expect(await code(openKeyFile(flag, PW()))).toBe('malformed');
  });

  it('refuses a KDF downgrade below the INTERACTIVE floor before running argon2id', async () => {
    const f = await sealed();
    for (const patch of [{ ops: COST.ops - 1 }, { mem: COST.mem - 1 }, { ops: 1, mem: 8192 }]) {
      const t = edit(f, (o) => {
        Object.assign(o['kdf'] as object, patch);
      });
      expect(await code(openKeyFile(t, PW()))).toBe('weak-parameters');
    }
    await expect(
      sealKeyFile({ secretKey: SK, pubkey: PUB, passphrase: PW(), cost: { ops: 1, mem: 8192 } }),
    ).rejects.toMatchObject({ code: 'weak-parameters' });
  });

  it('refuses a crafted file asking for more memory or passes than the unlock limits (no memory-exhaustion at unlock)', async () => {
    const f = await sealed();
    for (const patch of [{ mem: MAX_MEM_BYTES + 1 }, { ops: 17 }, { mem: 2 ** 40 }]) {
      const t = edit(f, (o) => {
        Object.assign(o['kdf'] as object, patch);
      });
      const started = Date.now();
      expect(await code(openKeyFile(t, PW()))).toBe('excessive-parameters');
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('refuses malformed files: not JSON, extra or missing fields, wrong kind or version, bad hex, bad lengths', async () => {
    const f = await sealed();
    const cases: [Uint8Array, string][] = [
      [enc.encode('not json'), 'malformed'],
      [enc.encode('[]'), 'malformed'],
      [new Uint8Array([0xff, 0xfe]), 'malformed'],
      [edit(f, (o) => (o['extra'] = 1)), 'malformed'],
      [edit(f, (o) => delete o['ct']), 'malformed'],
      [edit(f, (o) => (o['kind'] = 'something-else')), 'malformed'],
      [edit(f, (o) => (o['v'] = 2)), 'unsupported-version'],
      [edit(f, (o) => ((o['kdf'] as { alg: string }).alg = 'scrypt')), 'unsupported-version'],
      [edit(f, (o) => ((o['kdf'] as { salt: string }).salt = 'zz'.repeat(16))), 'malformed'],
      [edit(f, (o) => ((o['aead'] as { nonce: string }).nonce = 'ab')), 'malformed'],
      [edit(f, (o) => (o['ct'] = (o['ct'] as string).slice(2))), 'malformed'],
      [edit(f, (o) => (o['pubkey'] = 'A'.repeat(64))), 'malformed'],
      [edit(f, (o) => ((o['kdf'] as { ops: unknown }).ops = '3')), 'malformed'],
    ];
    for (const [file, want] of cases) expect(await code(openKeyFile(file, PW()))).toBe(want);
  });

  it('refuses to seal bad inputs', async () => {
    await expect(
      sealKeyFile({ secretKey: new Uint8Array(31), pubkey: PUB, passphrase: PW(), cost: COST }),
    ).rejects.toMatchObject({ code: 'bad-key' });
    await expect(
      sealKeyFile({ secretKey: SK, pubkey: 'nothex', passphrase: PW(), cost: COST }),
    ).rejects.toMatchObject({ code: 'bad-key' });
    await expect(
      sealKeyFile({ secretKey: SK, pubkey: PUB, passphrase: new Uint8Array(0), cost: COST }),
    ).rejects.toMatchObject({ code: 'bad-passphrase' });
  });
});
