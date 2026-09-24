/**
 * SignerManager (`SignerControl`): the flows, the status feed, and the key-material rules —
 * a prompt's secret is wiped after use, nothing secret reaches `SignerStatus`, a failed
 * connect leaves the previous state intact, and connects never interleave.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';

import type { SignerStatus } from '../../contracts/index.js';
import { SignerManager, type KeyStore, type SecretPrompt } from '../control.js';
import { minimumCost } from '../keyfile.js';
import type { BunkerLike } from '../remote.js';

const enc = new TextEncoder();
const COST = minimumCost();

function memStore(): KeyStore & { file: Uint8Array | null; writes: number } {
  const s = {
    file: null as Uint8Array | null,
    writes: 0,
    read: () => Promise.resolve(s.file),
    write: (f: Uint8Array) => {
      s.file = f;
      s.writes++;
      return Promise.resolve();
    },
  };
  return s;
}

/** Answers from a script and remembers every buffer it handed out (to check they get wiped). */
function script(
  answers: Partial<Record<Parameters<SecretPrompt['ask']>[0], string | null>>,
): SecretPrompt & {
  handed: Uint8Array[];
} {
  const handed: Uint8Array[] = [];
  return {
    handed,
    ask: (kind) => {
      const a = answers[kind];
      if (a === undefined || a === null) return Promise.resolve(null);
      const b = enc.encode(a);
      handed.push(b);
      return Promise.resolve(b);
    },
  };
}

describe('SignerManager', () => {
  it('generate → unlock → lock → disconnect, with the status feed and no secret in any status', async () => {
    const store = memStore();
    const prompt = script({
      'new-passphrase': 'pw one two three',
      'unlock-passphrase': 'pw one two three',
    });
    const m = new SignerManager({ prompt, keyStore: store, cost: COST });
    const seen: SignerStatus[] = [];
    m.onStatus((s) => seen.push(s));
    expect(m.status()).toMatchObject({ pubkey: null, locked: true });

    const st = await m.connect({ kind: 'local', flow: 'generate' });
    expect(st).toMatchObject({ kind: 'local', locked: false, supportsSignSecret: false });
    expect(st.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(store.writes).toBe(1);
    const pk = st.pubkey;

    await m.lock();
    expect(m.status()).toMatchObject({ pubkey: pk, locked: true });
    await expect(
      m.current()!.signEvent({ kind: 1, created_at: 1, tags: [], content: '' }),
    ).rejects.toThrow(/signer-locked/);

    const again = await m.connect({ kind: 'local', flow: 'unlock' });
    expect(again).toMatchObject({ pubkey: pk, locked: false });

    await m.disconnect();
    expect(m.status()).toMatchObject({ pubkey: null, locked: true });
    expect(m.current()).toBeNull();

    expect(seen.map((s) => [s.locked, s.pubkey === null])).toEqual([
      [false, false],
      [true, false],
      [false, false],
      [true, true],
    ]);
    // Every secret the prompt handed out was wiped after use.
    expect(prompt.handed.length).toBeGreaterThanOrEqual(2);
    for (const b of prompt.handed) expect(b.every((x) => x === 0)).toBe(true);
    // No status ever carried the file or a passphrase.
    const text = JSON.stringify(seen);
    expect(text).not.toContain('pw one');
    expect(text).not.toContain(new TextDecoder().decode(store.file!).slice(-40));
  });

  it('import: parses the nsec from the prompt, seals it, and wipes the nsec buffer', async () => {
    const sk = new Uint8Array(32).fill(6);
    const store = memStore();
    const prompt = script({
      'import-nsec': nsecEncode(sk),
      'new-passphrase': 'another passphrase',
    });
    const m = new SignerManager({ prompt, keyStore: store, cost: COST });
    const st = await m.connect({ kind: 'local', flow: 'import' });
    expect(st.pubkey).toBe(getPublicKey(sk));
    for (const b of prompt.handed) expect(b.every((x) => x === 0)).toBe(true);
  });

  it('a wrong passphrase, a cancelled prompt, or no key file leaves the previous signer in place', async () => {
    const store = memStore();
    const m = new SignerManager({
      prompt: script({ 'new-passphrase': 'right passphrase' }),
      keyStore: store,
      cost: COST,
    });
    const first = await m.connect({ kind: 'local', flow: 'generate' });

    const wrong = new SignerManager({
      prompt: script({ 'unlock-passphrase': 'wrong' }),
      keyStore: store,
      cost: COST,
    });
    await expect(wrong.connect({ kind: 'local', flow: 'unlock' })).rejects.toThrow(
      /bad-passphrase/,
    );
    expect(wrong.status().pubkey).toBeNull();

    const cancel = new SignerManager({ prompt: script({}), keyStore: store, cost: COST });
    await expect(cancel.connect({ kind: 'local', flow: 'unlock' })).rejects.toThrow(/cancelled/);

    const none = new SignerManager({ prompt: script({}), keyStore: memStore(), cost: COST });
    await expect(none.connect({ kind: 'local', flow: 'unlock' })).rejects.toThrow(/no-signer/);

    // Generating over an existing key is refused (it would orphan the old one).
    await expect(m.connect({ kind: 'local', flow: 'generate' })).rejects.toThrow(/already exists/);
    expect(m.status()).toMatchObject({ pubkey: first.pubkey, locked: false });
  });

  it('NIP-46 through the injected connector: the URI shape is checked, the status shows relay + pubkey, never the URI secret', async () => {
    const sk = new Uint8Array(32).fill(9);
    const pk = getPublicKey(sk);
    let closed = false;
    const bunker: BunkerLike = {
      getPublicKey: () => Promise.resolve(pk),
      signEvent: (t) => Promise.resolve(finalizeEvent({ ...t }, sk)),
      nip44Encrypt: () => Promise.resolve('x'),
      nip44Decrypt: () => Promise.resolve('x'),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const uris: string[] = [];
    const m = new SignerManager({
      prompt: script({}),
      keyStore: memStore(),
      nip46: (uri) => {
        uris.push(uri);
        return Promise.resolve({ bunker, relays: ['wss://relay.example'] });
      },
    });
    await expect(m.connect({ kind: 'nip46', uri: 'https://evil.example' })).rejects.toThrow(
      /invalid-argument/,
    );
    const uri = `bunker://${pk}?relay=wss://relay.example&secret=topsecret`;
    const st = await m.connect({ kind: 'nip46', uri });
    expect(st).toMatchObject({ kind: 'nip46', pubkey: pk, locked: false });
    expect(st.detail).toContain('wss://relay.example');
    expect(JSON.stringify(st)).not.toContain('topsecret');
    await m.disconnect();
    expect(closed).toBe(true);
    expect(uris).toEqual([uri]);
  });

  it('NIP-07 with no extension is `no-signer`; NIP-46 without a connector is `unsupported`', async () => {
    const m = new SignerManager({ prompt: script({}), keyStore: memStore(), nip07: () => null });
    await expect(m.connect({ kind: 'nip07' })).rejects.toThrow(/no-signer/);
    await expect(m.connect({ kind: 'nip46', uri: 'bunker://x' })).rejects.toThrow(/unsupported/);
  });

  it('connects are serialised: two concurrent requests never interleave their prompts', async () => {
    const order: string[] = [];
    const store = memStore();
    const seed = new SignerManager({
      prompt: script({ 'new-passphrase': 'pp pp pp pp' }),
      keyStore: store,
      cost: COST,
    });
    await seed.connect({ kind: 'local', flow: 'generate' });
    const prompt: SecretPrompt = {
      ask: async (kind) => {
        order.push(`ask:${kind}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`answer:${kind}`);
        return enc.encode('pp pp pp pp');
      },
    };
    const m = new SignerManager({ prompt, keyStore: store, cost: COST });
    await Promise.all([
      m.connect({ kind: 'local', flow: 'unlock' }),
      m.connect({ kind: 'local', flow: 'unlock' }),
    ]);
    expect(order).toEqual([
      'ask:unlock-passphrase',
      'answer:unlock-passphrase',
      'ask:unlock-passphrase',
      'answer:unlock-passphrase',
    ]);
  });
});
