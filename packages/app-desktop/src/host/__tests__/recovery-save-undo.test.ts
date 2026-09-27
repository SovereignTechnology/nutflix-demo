/**
 * ADR 0016: saving a new phrase moves the old counters aside (the new phrase derives from counter
 * 0). If the new phrase's own write then fails, the old phrase stays current — so its counters
 * must come back, or core would find none (a probe at best, a repeated secret at worst). The
 * files module is wrapped so exactly that last write fails.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NostrPubkey, RelayUrl, UnixSeconds } from '@sovit/core';
import { nostr, signer as signerMod } from '@sovit/core';

import type { MoneyPlane } from '../money.js';
import type * as Files from '../recovery/files.js';
import { memoryLogger } from '../log.js';
import { MainBridge } from '../signer/main-bridge.js';
import { FakeRecoveryCore } from './support/fake-recovery.js';

type FilesModule = typeof Files;

const fail = { next: false };
vi.mock('../recovery/files.js', async (importOriginal) => {
  const real = await importOriginal<FilesModule>();
  return {
    ...real,
    writeEnvelope: (dir: string, path: string, env: Parameters<typeof real.writeEnvelope>[2]) => {
      if (fail.next && path.endsWith('.sealed')) {
        fail.next = false;
        return Promise.reject(new Error('EIO: disk full'));
      }
      return real.writeEnvelope(dir, path, env);
    },
  };
});

const { RecoveryService } = await import('../recovery/service.js');

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe('a failed save puts the counters back', () => {
  it('the new phrase write fails → the old counters file is where it was, nothing is left retired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nf-n2-undo-'));
    roots.push(root);
    const dir = join(root, 'wallet');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { signer } = await signerMod.LocalSigner.create({
      passphrase: new TextEncoder().encode('a long enough passphrase'),
      cost: signerMod.minimumCost(),
    });
    const pubkey: NostrPubkey = await signer.getPublicKey();
    const counters = join(dir, `counters-${pubkey}.json`);
    const state = JSON.stringify({ v: 1, next: { '00ad268c4d1f5826': 40 }, published: {} });
    await writeFile(counters, state, { mode: 0o600 });
    const core = new FakeRecoveryCore();
    const bridge: MainBridge = new MainBridge({
      post: (m) => {
        if (m.kind === 'prompt')
          queueMicrotask(() => {
            bridge.onPromptAnswer(
              m.req,
              m.form.kind === 'recovery-show' ? { kind: 'recovery-show', done: false } : null,
            );
          });
      },
    });
    const plane = { pubkey, mints: [], seeded: undefined } as unknown as MoneyPlane;
    const svc = new RecoveryService({
      core,
      dir,
      bridge,
      signer: () => signer,
      plane: () => plane,
      reopenMoney: async (between) => {
        await between?.();
      },
      checkPassphrase: () => Promise.resolve(false),
      relays: {
        pool: new nostr.FakeRelayPool(),
        write: () => ['wss://r.test' as RelayUrl],
        read: () => [],
      },
      log: memoryLogger(),
      now: () => 1 as UnixSeconds,
    });
    fail.next = true;
    await expect(svc.setup()).rejects.toMatchObject({ code: 'internal' });
    expect(await readFile(counters, 'utf8')).toBe(state);
    expect((await readdir(dir)).filter((n) => n.endsWith('.retired'))).toEqual([]);
    expect(await readdir(dir)).not.toContain(`recovery-${pubkey}.sealed`);
  });
});
