/**
 * The desktop signer flow (ADR 0013) against a scripted "main": the prompt window's answers and
 * the OS keychain are fakes, the key file is real (a temp userData, core's argon2id at the
 * INTERACTIVE floor), the money plane is a stub that records how it was opened.
 *
 * What must hold:
 *   - the renderer names a kind only; the method, the flow and every secret come from the prompt;
 *   - the key file is 0600 in a 0700 directory, and a key file others can read is refused;
 *   - "keychain" seals exactly the passphrase typed, unlocks silently at the next launch, and a
 *     sealed passphrase that stopped working is dropped and asked for instead;
 *   - a wrong passphrase is asked again (retry), a few times, then the signer stays locked;
 *   - sign out forgets the keychain's secrets and the identity (the key file stays);
 *   - a brand-new key gets a wallet at once; an existing identity is ASKED (default no), and never
 *     at an unattended launch;
 *   - a remembered bunker session is sealed and resumed; "remember" without a keychain is refused;
 *   - flows are exclusive, and the secrets the host was handed are wiped after use.
 */
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NostrPubkey, Signer } from '@sovit/core';
import { signer as signerMod } from '@sovit/core';

import type { HostOut, KeychainSlot, PromptAnswer, PromptForm } from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import type { Nip46Connector } from '../signer/desktop-signer.js';
import { DesktopSigner, MIN_NEW_PASSPHRASE_BYTES } from '../signer/desktop-signer.js';
import { MainBridge } from '../signer/main-bridge.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PASS = 'correct horse battery staple';

type Script = (form: PromptForm) => PromptAnswer | null;

/** A fake main: answers prompts from `script`, keeps a keychain, records every question. */
class FakeMain {
  readonly asked: PromptForm[] = [];
  readonly keychain = new Map<KeychainSlot, Uint8Array>();
  readonly keychainOps: string[] = [];
  /** What main handed the host, by reference: the host must wipe these. */
  readonly handed: Uint8Array[] = [];
  script: Script = () => null;
  /** Hold prompt answers until `release()` (to test exclusivity). */
  hold = false;
  private held: (() => void)[] = [];
  bridge!: MainBridge;

  post = (out: HostOut): void => {
    if (out.kind === 'prompt') {
      this.asked.push(out.form);
      const answer = (): void => {
        const a = this.script(out.form);
        if (a?.kind === 'secret') this.handed.push(a.value);
        if (a?.kind === 'bunker') this.handed.push(a.uri);
        queueMicrotask(() => {
          this.bridge.onPromptAnswer(out.req, a);
        });
      };
      if (this.hold) this.held.push(answer);
      else answer();
    } else if (out.kind === 'keychain') {
      this.keychainOps.push(`${out.op}:${out.slot}`);
      let value: Uint8Array | null = null;
      if (out.op === 'put' && out.value !== undefined)
        this.keychain.set(out.slot, Uint8Array.from(out.value)); // parentPort clones
      else if (out.op === 'forget') this.keychain.delete(out.slot);
      else if (out.op === 'get') {
        const v = this.keychain.get(out.slot);
        value = v === undefined ? null : Uint8Array.from(v);
      }
      queueMicrotask(() => {
        this.bridge.onKeychainResult(out.req, true, value);
      });
    }
  };

  release(): void {
    this.hold = false;
    for (const h of this.held.splice(0)) h();
  }
}

interface Opened {
  readonly create: boolean;
  readonly signer: Signer;
  closed: boolean;
}

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'nf-signer-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

function setup(o: {
  keychain?: boolean;
  /** `journal-broken`: the wallet journal does not open (ADR 0014 amendment, issue #8). */
  wallet?: 'exists' | 'missing' | 'journal-broken';
  nip46?: Nip46Connector;
  main?: FakeMain;
  now?: () => number;
}): {
  main: FakeMain;
  signer: DesktopSigner;
  opened: Opened[];
  swaps: number[];
  log: ReturnType<typeof memoryLogger>;
} {
  const main = o.main ?? new FakeMain();
  const bridge = new MainBridge({ post: main.post });
  main.bridge = bridge;
  const opened: Opened[] = [];
  const swaps: number[] = [];
  let walletExists = o.wallet !== 'missing';
  const log = memoryLogger('debug');
  const signer = new DesktopSigner({
    dir: join(userData, 'signer'),
    bridge,
    keychain: o.keychain === true,
    log,
    cost: signerMod.minimumCost(),
    openMoney: (s, create) => {
      if (o.wallet === 'journal-broken')
        return Promise.reject(new Error('journal-unreadable: the journal does not verify'));
      if (!create && !walletExists)
        return Promise.reject(new Error('no-wallet: no NIP-60 wallet event was found'));
      walletExists = true;
      const rec: Opened = { create, signer: s, closed: false };
      opened.push(rec);
      return Promise.resolve({
        wallet: {},
        mints: [],
        close: () => {
          rec.closed = true;
        },
      } as unknown as MoneyPlane);
    },
    swap: async (change) => {
      swaps.push(swaps.length);
      await change();
    },
    ...(o.nip46 === undefined ? {} : { nip46: o.nip46 }),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { main, signer, opened, swaps, log };
}

/** Answers for a first-time local key: `method`, `flow`, then the passphrase (and nsec). */
function localScript(
  method: 'passphrase' | 'keychain',
  flow: 'generate' | 'import' | 'unlock',
  pass = PASS,
  nsec?: string,
): Script {
  return (f) => {
    switch (f.kind) {
      case 'local-setup':
        return { kind: 'local-setup', method, flow };
      case 'new-passphrase':
      case 'unlock-passphrase':
        return { kind: 'secret', value: enc(pass) };
      case 'import-nsec':
        return { kind: 'secret', value: enc(nsec ?? '') };
      case 'bunker':
      case 'create-wallet':
      case 'remove-key':
      case 'bunker-auth':
      case 'top-up-first': // issue #2: the auto top-up's question, never part of this flow
        return null;
    }
  };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

describe('DesktopSigner — local key', () => {
  // Issue #8 (ADR 0014 amendment): a wallet journal that does not open refuses the wallet —
  // loudly (an error line, and the reason the host shows instead of "no wallet"), never by
  // offering to create a new wallet over it.
  it('a journal that does not open: no money plane, the reason kept, logged as an error, no create prompt', async () => {
    const { main, signer, log } = setup({ wallet: 'journal-broken' });
    main.script = localScript('passphrase', 'generate');
    const st = await signer.connect({ kind: 'local' });
    expect(st).toMatchObject({ kind: 'local', locked: false });
    expect(signer.money()).toBeUndefined();
    expect(signer.moneyError()).toBe('journal-unreadable');
    expect(main.asked.map((f) => f.kind)).not.toContain('create-wallet');
    expect(log.lines.some((l) => l.level === 'error' && l.msg.includes('wallet journal'))).toBe(
      true,
    );
    // Locking forgets it (a later unlock tries again).
    await signer.lock();
    expect(signer.moneyError()).toBeNull();
  });

  it('generate + passphrase: a 0600 key file in a 0700 dir, unlocked, a new wallet at once', async () => {
    const { main, signer, opened } = setup({});
    main.script = localScript('passphrase', 'generate');
    const st = await signer.connect({ kind: 'local' });
    expect(st).toMatchObject({ kind: 'local', locked: false });
    expect(st.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(main.asked.map((f) => f.kind)).toEqual(['local-setup', 'new-passphrase']);
    expect(main.asked[0]).toEqual({ kind: 'local-setup', hasKey: false, keychain: false });
    const dir = await stat(join(userData, 'signer'));
    const file = await stat(join(userData, 'signer', 'local.key'));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.create).toBe(true); // a brand-new key cannot have a wallet to replace
    expect(signer.money()).toBeDefined();
    expect(await signer.info()).toEqual({
      method: 'passphrase',
      hasLocalKey: true,
      keychain: false,
      remembered: false,
    });
    const method = JSON.parse(await readFile(join(userData, 'signer', 'method.json'), 'utf8')) as {
      method: string;
    };
    expect(method.method).toBe('passphrase');
    // Nothing touched a keychain that does not exist here.
    expect(main.keychainOps).toEqual([]);
    // Every secret handed to the host was wiped once used.
    for (const b of main.handed) expect(b.every((x) => x === 0)).toBe(true);
  });

  it('refuses a new passphrase shorter than the floor, and writes no key', async () => {
    const { main, signer } = setup({});
    main.script = localScript('passphrase', 'generate', 'x'.repeat(MIN_NEW_PASSPHRASE_BYTES - 1));
    expect(await code(signer.connect({ kind: 'local' }))).toBe('invalid-argument');
    expect(await signer.keyStore.exists()).toBe(false);
    expect(signer.signer()).toBeUndefined();
  });

  it('cancel at any step: `cancelled`, nothing written', async () => {
    const { main, signer } = setup({});
    main.script = () => null;
    expect(await code(signer.connect({ kind: 'local' }))).toBe('cancelled');
    main.script = (f) =>
      f.kind === 'local-setup' ? localScript('passphrase', 'generate')(f) : null;
    expect(await code(signer.connect({ kind: 'local' }))).toBe('cancelled');
    expect(await signer.keyStore.exists()).toBe(false);
  });

  it('an answer the question did not offer (keychain where there is none) is a cancel', async () => {
    const { main, signer } = setup({ keychain: false });
    main.script = localScript('keychain', 'generate');
    expect(await code(signer.connect({ kind: 'local' }))).toBe('cancelled');
    expect(await signer.keyStore.exists()).toBe(false);
  });

  it('passphrase each launch: asks at start, retries a wrong one, stays locked after three', async () => {
    const first = setup({});
    first.main.script = localScript('passphrase', 'generate');
    const { pubkey } = await first.signer.connect({ kind: 'local' });
    await first.signer.close();

    // Next launch: wrong, then right.
    const main = new FakeMain();
    let n = 0;
    main.script = (f) => {
      if (f.kind !== 'unlock-passphrase') return null;
      n++;
      return { kind: 'secret', value: enc(n === 1 ? 'wrong passphrase!' : PASS) };
    };
    const next = setup({ main });
    await next.signer.start();
    expect(main.asked).toEqual([
      { kind: 'unlock-passphrase', retry: false },
      { kind: 'unlock-passphrase', retry: true },
    ]);
    expect((await next.signer.status()).locked).toBe(false);
    expect(await next.signer.me()).toBe(pubkey);
    expect(next.opened.at(-1)?.create).toBe(false);
    await next.signer.close();

    // And a launch where every try is wrong: locked, but still names its owner.
    const bad = new FakeMain();
    bad.script = (f) =>
      f.kind === 'unlock-passphrase' ? { kind: 'secret', value: enc('nope nope nope') } : null;
    const third = setup({ main: bad });
    await third.signer.start();
    expect(bad.asked).toHaveLength(3);
    expect(third.signer.signer()).toBeUndefined();
    expect(await third.signer.status()).toMatchObject({ kind: 'local', pubkey, locked: true });
    expect(third.opened).toHaveLength(0);
  });

  it('keychain: seals exactly the passphrase typed and unlocks silently at the next launch', async () => {
    const first = setup({ keychain: true });
    first.main.script = localScript('keychain', 'generate');
    await first.signer.connect({ kind: 'local' });
    expect(new TextDecoder().decode(first.main.keychain.get('passphrase'))).toBe(PASS);
    expect(first.main.keychainOps).toContain('put:passphrase');
    expect((await first.signer.info()).method).toBe('keychain');
    await first.signer.close();

    const main = new FakeMain();
    main.keychain.set('passphrase', enc(PASS));
    const next = setup({ keychain: true, main });
    await next.signer.start();
    expect(main.asked).toEqual([]); // no window at all
    expect(next.signer.signer()).toBeDefined();
  });

  it('keychain: a sealed passphrase that no longer unlocks is dropped, asked, and sealed anew', async () => {
    const first = setup({ keychain: true });
    first.main.script = localScript('keychain', 'generate');
    await first.signer.connect({ kind: 'local' });
    await first.signer.close();

    const main = new FakeMain();
    main.keychain.set('passphrase', enc('stale passphrase value'));
    main.script = localScript('keychain', 'unlock');
    const next = setup({ keychain: true, main });
    await next.signer.start();
    expect(main.keychainOps).toEqual(['get:passphrase', 'forget:passphrase', 'put:passphrase']);
    expect(main.asked).toEqual([{ kind: 'unlock-passphrase', retry: false }]);
    expect(new TextDecoder().decode(main.keychain.get('passphrase'))).toBe(PASS);
    expect(next.signer.signer()).toBeDefined();
  });

  it('switching from keychain to passphrase removes the sealed copy', async () => {
    const s = setup({ keychain: true });
    s.main.script = localScript('keychain', 'generate');
    await s.signer.connect({ kind: 'local' });
    expect(s.main.keychain.has('passphrase')).toBe(true);
    s.main.script = localScript('passphrase', 'unlock');
    await s.signer.connect({ kind: 'local' });
    expect(s.main.keychain.has('passphrase')).toBe(false);
    expect((await s.signer.info()).method).toBe('passphrase');
  });

  it('import: the nsec becomes this key (and is wiped)', async () => {
    const sk = new Uint8Array(32).fill(7);
    const nsecHex = Buffer.from(sk).toString('hex');
    const { main, signer } = setup({ wallet: 'missing' });
    main.script = (f) =>
      f.kind === 'create-wallet'
        ? { kind: 'create-wallet', create: false }
        : localScript('passphrase', 'import', PASS, nsecHex)(f);
    const st = await signer.connect({ kind: 'local' });
    const expected = await signerMod.LocalSigner.create({
      passphrase: enc('another passphrase'),
      secretKey: sk,
      cost: signerMod.minimumCost(),
    });
    expect(st.pubkey).toBe(await expected.signer.getPublicKey());
    await expected.signer.lock();
    expect(main.asked.map((f) => f.kind)).toEqual([
      'local-setup',
      'import-nsec',
      'new-passphrase',
      'create-wallet',
    ]);
    for (const b of main.handed) expect(b.every((x) => x === 0)).toBe(true);
  });

  it('refuses a key file other users can read', async () => {
    const s = setup({});
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' });
    await s.signer.close();
    await chmod(join(userData, 'signer', 'local.key'), 0o644);
    const main = new FakeMain();
    main.script = localScript('passphrase', 'unlock');
    const next = setup({ main });
    await next.signer.start();
    expect(next.signer.signer()).toBeUndefined();
    expect(main.asked).toEqual([]); // refused before any passphrase was asked
    expect(await code(next.signer.unlock())).toBe('forbidden');
  });
});

describe('DesktopSigner — removing the key (a forgotten passphrase)', () => {
  it('asks first ("Keep it" keeps it), then deletes the file, the keychain copy and the identity', async () => {
    const s = setup({ keychain: true });
    s.main.script = localScript('keychain', 'generate');
    await s.signer.connect({ kind: 'local' });
    expect(s.main.keychain.has('passphrase')).toBe(true);
    const keyPath = join(userData, 'signer', 'local.key');

    s.main.asked.length = 0;
    s.main.script = (f) =>
      f.kind === 'local-setup'
        ? { kind: 'local-setup', method: 'passphrase', flow: 'remove' }
        : f.kind === 'remove-key'
          ? { kind: 'remove-key', confirm: false }
          : null;
    expect(await code(s.signer.connect({ kind: 'local' }))).toBe('cancelled');
    expect(s.main.asked).toEqual([
      { kind: 'local-setup', hasKey: true, keychain: true },
      { kind: 'remove-key' },
    ]);
    expect((await stat(keyPath)).isFile()).toBe(true);
    expect(s.signer.signer()).toBeDefined();

    s.main.script = (f) =>
      f.kind === 'local-setup'
        ? { kind: 'local-setup', method: 'passphrase', flow: 'remove' }
        : f.kind === 'remove-key'
          ? { kind: 'remove-key', confirm: true }
          : null;
    const st = await s.signer.connect({ kind: 'local' });
    expect(st).toMatchObject({ pubkey: null, locked: true });
    await expect(stat(keyPath)).rejects.toThrow();
    expect(s.main.keychain.has('passphrase')).toBe(false);
    expect(await s.signer.info()).toMatchObject({ method: null, hasLocalKey: false });
    expect(s.signer.money()).toBeUndefined();
    // With no key, the next connect offers create / import again.
    s.main.asked.length = 0;
    s.main.script = () => null;
    await code(s.signer.connect({ kind: 'local' }));
    expect(s.main.asked[0]).toEqual({ kind: 'local-setup', hasKey: false, keychain: true });
  });

  it('"remove" is not an answer when there is no key', async () => {
    const s = setup({});
    s.main.script = (f) =>
      f.kind === 'local-setup'
        ? { kind: 'local-setup', method: 'passphrase', flow: 'remove' }
        : null;
    expect(await code(s.signer.connect({ kind: 'local' }))).toBe('cancelled');
    expect(s.main.asked.map((f) => f.kind)).toEqual(['local-setup']);
  });
});

describe('DesktopSigner — lock, sign out, exclusivity', () => {
  it('lock closes the money plane; unlock asks again', async () => {
    const s = setup({});
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' });
    const plane = s.opened.at(-1);
    await s.signer.lock();
    expect(plane?.closed).toBe(true);
    expect(s.signer.money()).toBeUndefined();
    expect((await s.signer.status()).locked).toBe(true);
    s.main.asked.length = 0;
    await s.signer.unlock();
    expect(s.main.asked).toEqual([{ kind: 'unlock-passphrase', retry: false }]);
    expect(s.signer.signer()).toBeDefined();
  });

  it('sign out forgets the keychain and the identity; the key file stays', async () => {
    const s = setup({ keychain: true });
    s.main.script = localScript('keychain', 'generate');
    await s.signer.connect({ kind: 'local' });
    await s.signer.signOut();
    expect(s.main.keychain.size).toBe(0);
    expect(s.main.keychainOps).toEqual(
      expect.arrayContaining(['forget:passphrase', 'forget:nip46']),
    );
    expect(await s.signer.status()).toMatchObject({ pubkey: null, locked: true });
    expect(await s.signer.info()).toMatchObject({ method: null, hasLocalKey: true });
    expect(s.signer.money()).toBeUndefined();
  });

  it('one flow at a time: a second connect while a prompt is open is refused', async () => {
    const s = setup({});
    s.main.script = localScript('passphrase', 'generate');
    s.main.hold = true;
    const first = s.signer.connect({ kind: 'local' });
    await Promise.resolve();
    expect(await code(s.signer.connect({ kind: 'nip46' }))).toBe('rate-limited');
    s.main.release();
    await first;
    expect(s.signer.signer()).toBeDefined();
  });

  it('a page cannot keep re-opening the prompt: three dismissals pause flows for a minute', async () => {
    let t = 1_000_000;
    const s = setup({ now: () => t });
    s.main.script = () => null;
    for (let i = 0; i < 3; i++)
      expect(await code(s.signer.connect({ kind: 'local' }))).toBe('cancelled');
    expect(s.main.asked).toHaveLength(3);
    expect(await code(s.signer.connect({ kind: 'nip46' }))).toBe('rate-limited');
    expect(await code(s.signer.unlock())).toBe('rate-limited');
    expect(s.main.asked).toHaveLength(3); // nothing was shown while cooling down
    t += 60_001;
    s.main.script = localScript('passphrase', 'generate');
    expect((await s.signer.connect({ kind: 'local' })).locked).toBe(false);
  });

  it('dismissals spread over more than a minute do not pause anything', async () => {
    let t = 1_000_000;
    const s = setup({ now: () => t });
    s.main.script = () => null;
    for (let i = 0; i < 5; i++) {
      expect(await code(s.signer.connect({ kind: 'local' }))).toBe('cancelled');
      t += 31_000;
    }
    expect(s.main.asked).toHaveLength(5);
  });

  it('status listeners hear every change', async () => {
    const s = setup({});
    const seen: boolean[] = [];
    s.signer.onStatus((st) => seen.push(st.locked));
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' });
    await s.signer.lock();
    expect(seen).toEqual([false, true]);
  });
});

describe('DesktopSigner — wallet creation', () => {
  it('an existing identity with no wallet is ASKED; no = no plane, yes = created', async () => {
    const s = setup({ wallet: 'missing' });
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' }); // generate: created at once
    await s.signer.lock();
    // Now pretend the relays show no wallet for it (a fresh setup around the same key).
    const main = new FakeMain();
    let create = false;
    main.script = (f) =>
      f.kind === 'create-wallet'
        ? { kind: 'create-wallet', create }
        : localScript('passphrase', 'unlock')(f);
    const next = setup({ main, wallet: 'missing' });
    await next.signer.connect({ kind: 'local' });
    expect(main.asked.map((f) => f.kind)).toEqual([
      'local-setup',
      'unlock-passphrase',
      'create-wallet',
    ]);
    expect(next.signer.money()).toBeUndefined();
    create = true;
    await next.signer.lock();
    await next.signer.unlock();
    expect(next.opened.at(-1)?.create).toBe(true);
    expect(next.signer.money()).toBeDefined();
  });

  it('never asks at an unattended launch', async () => {
    const s = setup({});
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' });
    await s.signer.close();
    const main = new FakeMain();
    main.script = (f) =>
      f.kind === 'create-wallet'
        ? { kind: 'create-wallet', create: true }
        : localScript('passphrase', 'unlock')(f);
    const next = setup({ main, wallet: 'missing' });
    await next.signer.start();
    expect(main.asked.map((f) => f.kind)).toEqual(['unlock-passphrase']);
    expect(next.signer.money()).toBeUndefined();
    expect(next.opened).toHaveLength(0);
  });
});

describe('DesktopSigner — remote signer (NIP-46)', () => {
  /** A connector whose bunker is a local key; records what it was asked. */
  function fakeNip46(): Nip46Connector & { uris: string[]; resumed: string[] } {
    const sk = new Uint8Array(32).fill(9);
    const uris: string[] = [];
    const resumed: string[] = [];
    const bunker = async (): Promise<signerMod.BunkerLike> => {
      const { signer } = await signerMod.LocalSigner.create({
        passphrase: enc('bunker side key'),
        secretKey: sk,
        cost: signerMod.minimumCost(),
      });
      return {
        getPublicKey: () => signer.getPublicKey(),
        signEvent: (t) => signer.signEvent(t),
        nip44Encrypt: (p, t) => signer.nip44Encrypt(p as NostrPubkey, t),
        nip44Decrypt: (p, c) => signer.nip44Decrypt(p as NostrPubkey, c),
        close: () => signer.lock(),
      };
    };
    return {
      uris,
      resumed,
      connect: async (uri, opts) => {
        uris.push(uri);
        const b = await bunker();
        return opts?.remember === true
          ? { bunker: b, relays: ['wss://r.test'], resume: enc('{"session":"blob"}') }
          : { bunker: b, relays: ['wss://r.test'] };
      },
      resume: async (blob) => {
        resumed.push(new TextDecoder().decode(blob));
        return { bunker: await bunker(), relays: ['wss://r.test'] };
      },
    };
  }
  const URI = `bunker://${'b'.repeat(64)}?relay=wss://r.test&secret=one-time`;

  it('the URI comes from the prompt, and a remembered session is sealed then resumed', async () => {
    const nip46 = fakeNip46();
    const s = setup({ keychain: true, nip46 });
    s.main.script = (f) =>
      f.kind === 'bunker' ? { kind: 'bunker', uri: enc(URI), remember: true } : null;
    const st = await s.signer.connect({ kind: 'nip46' });
    expect(st).toMatchObject({ kind: 'nip46', locked: false });
    expect(nip46.uris).toEqual([URI]);
    expect(s.main.asked).toEqual([{ kind: 'bunker', keychain: true }]);
    expect(new TextDecoder().decode(s.main.keychain.get('nip46'))).toBe('{"session":"blob"}');
    expect(await s.signer.info()).toMatchObject({ method: 'nip46', remembered: true });
    for (const b of s.main.handed) expect(b.every((x) => x === 0)).toBe(true);
    await s.signer.close();

    const main = new FakeMain();
    main.keychain.set('nip46', enc('{"session":"blob"}'));
    const again = fakeNip46();
    const next = setup({ keychain: true, nip46: again, main });
    await next.signer.start();
    expect(again.resumed).toEqual(['{"session":"blob"}']);
    expect(main.asked).toEqual([]);
    expect(next.signer.signer()?.kind).toBe('nip46');
  });

  it('an approval link (auth_url) is asked in the prompt window: https only, one at a time, bounded', async () => {
    let t = 5_000_000;
    const nip46 = fakeNip46();
    const links: string[] = [];
    const connector: Nip46Connector = {
      connect: async (uri, opts) => {
        for (const l of links) opts?.onauth?.(l);
        return nip46.connect(uri, opts);
      },
      resume: nip46.resume,
    };
    const s = setup({ nip46: connector, now: () => t });
    s.main.hold = true; // approval prompts stay open until released
    s.main.script = (f) =>
      f.kind === 'bunker'
        ? { kind: 'bunker', uri: enc(URI), remember: false }
        : f.kind === 'bunker-auth'
          ? { kind: 'bunker-auth', open: true }
          : null;
    links.push(
      'http://auth.example/plain-http',
      'https://user:pw@auth.example/creds',
      'https://auth.example/approve?x=1',
      'https://auth.example/second-while-open',
    );
    const done = s.signer.connect({ kind: 'nip46' });
    await Promise.resolve();
    s.main.release();
    await done;
    const auth = s.main.asked.filter((f) => f.kind === 'bunker-auth');
    expect(auth).toEqual([{ kind: 'bunker-auth', url: 'https://auth.example/approve?x=1' }]);
    // Bounded: five approval prompts per ten minutes, then ignored until the window passes.
    links.length = 0;
    links.push('https://auth.example/again');
    for (let i = 0; i < 6; i++) {
      await s.signer.connect({ kind: 'nip46' });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(s.main.asked.filter((f) => f.kind === 'bunker-auth')).toHaveLength(5);
    t += 10 * 60_000 + 1;
    await s.signer.connect({ kind: 'nip46' });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.main.asked.filter((f) => f.kind === 'bunker-auth')).toHaveLength(6);
  });

  it('"remember" where there is no keychain does not fit the question: cancelled', async () => {
    const nip46 = fakeNip46();
    const s = setup({ keychain: false, nip46 });
    s.main.script = (f) =>
      f.kind === 'bunker' ? { kind: 'bunker', uri: enc(URI), remember: true } : null;
    expect(await code(s.signer.connect({ kind: 'nip46' }))).toBe('cancelled');
    expect(nip46.uris).toEqual([]);
  });

  it('without remember nothing is sealed, and a local key switch forgets a sealed session', async () => {
    const nip46 = fakeNip46();
    const s = setup({ keychain: true, nip46 });
    s.main.script = (f) =>
      f.kind === 'bunker' ? { kind: 'bunker', uri: enc(URI), remember: false } : null;
    await s.signer.connect({ kind: 'nip46' });
    expect(s.main.keychain.has('nip46')).toBe(false);
    s.main.keychain.set('nip46', enc('old'));
    s.main.script = localScript('passphrase', 'generate');
    await s.signer.connect({ kind: 'local' });
    expect(s.main.keychain.has('nip46')).toBe(false);
    expect(s.signer.signer()?.kind).toBe('local');
  });
});
