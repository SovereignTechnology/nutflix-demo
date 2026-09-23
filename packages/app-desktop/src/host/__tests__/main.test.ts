/**
 * The utilityProcess entry glue (`runHost`) with a fake `process.parentPort`, and the dev
 * fences for programmatic callers of `createHost`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HostOut } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { HostArgsError } from '../flags.js';
import type { Host } from '../host.js';
import { createHost } from '../host.js';
import { memoryLogger } from '../log.js';
import type { ParentPortLike } from '../main.js';
import { runHost } from '../main.js';
import { FakeWorker, fakeSpawner } from './support/fake-worker.js';
import { eventually } from './support/rig.js';

const dirs: string[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) h.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function fakePort(): ParentPortLike & {
  readonly posted: HostOut[];
  deliver(data: unknown): void;
} {
  const posted: HostOut[] = [];
  let listener: ((e: { readonly data: unknown }) => void) | undefined;
  return {
    posted,
    on: (_event, l) => {
      listener = l;
    },
    postMessage: (m) => {
      posted.push(structuredClone(m) as HostOut);
    },
    deliver: (data) => {
      listener?.({ data: structuredClone(data) });
    },
  };
}

describe('runHost', () => {
  it('binds the host to the parent port: messages in, structured-cloned HostOut back', async () => {
    const ud = await mkdtemp(join(tmpdir(), 'nf-l6b-main-'));
    dirs.push(ud);
    const port = fakePort();
    const spawner = fakeSpawner(() => new FakeWorker());
    const host = await runHost({
      parentPort: port,
      argv: [`--user-data-dir=${ud}`, '--worker-entry=/opt/nutflix/worker.js', '--dev-mocks'],
      log: memoryLogger(),
      spawn: spawner.spawn,
    });
    hosts.push(host);
    port.deliver({ kind: 'call', wc: 1, msg: { v: IPC_V, id: 7, method: 'me', args: [] } });
    await eventually(() => port.posted.find((o) => o.kind === 'reply'), 'a reply');
    expect(port.posted.find((o) => o.kind === 'reply')).toEqual({
      kind: 'reply',
      wc: 1,
      msg: { v: IPC_V, id: 7, ok: true, result: expect.stringMatching(/^[0-9a-f]{64}$/) as string },
    });
    expect(spawner.spawned).toHaveLength(1);
  });

  it('rejects bad arguments before starting anything', async () => {
    const spawner = fakeSpawner();
    await expect(
      runHost({
        parentPort: fakePort(),
        argv: ['--user-data-dir=/tmp/x', '--worker-entry=/w.js', '--dev-fixtures'],
        log: memoryLogger(),
        spawn: spawner.spawn,
      }),
    ).rejects.toThrow(HostArgsError);
    expect(spawner.spawned).toEqual([]);
  });
});

describe('createHost dev fences (programmatic callers too)', () => {
  it.each([
    [{ devMocks: false, devFixtures: true }],
    [
      {
        devMocks: false,
        devFixtures: false,
        devBootstrap: [{ host: '127.0.0.1' as const, port: 1 }],
      },
    ],
  ])('%j is refused', async (flags) => {
    const ud = await mkdtemp(join(tmpdir(), 'nf-l6b-main-'));
    dirs.push(ud);
    const spawner = fakeSpawner();
    await expect(
      createHost({
        userData: ud,
        flags,
        post: () => undefined,
        log: memoryLogger(),
        workerEntry: '/w.js',
        spawn: spawner.spawn,
      }),
    ).rejects.toThrow(HostArgsError);
    expect(spawner.spawned).toEqual([]);
  });
});
