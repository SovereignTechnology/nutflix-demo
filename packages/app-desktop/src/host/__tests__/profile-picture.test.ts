/**
 * ADR 0015 part c: `setProfilePicture` — the picture into our profile core (the worker writes it),
 * then our newest kind 0 re-published with every other field kept and the picture fields set.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { NostrKind, nostr } from '@sovit/core';

import { NoIdentity, SignerIdentity } from '../identity.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

const kit = await coreTestKit();
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const REF = {
  url: `hyper://${'cd'.repeat(32)}/0-1`,
  sha256: 'ef'.repeat(32),
  size: JPEG.byteLength,
};

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

describe('setProfilePicture (ADR 0015 part c)', () => {
  it('writes the picture over the worker and re-publishes our kind 0, keeping every other field', async () => {
    const me = new kit.TestSigner();
    const puts: string[] = [];
    r = await rig({
      flags: { devMocks: true },
      identity: new SignerIdentity(me),
      worker: {
        handlers: {
          'profile.putImage': (a: { hex: string }) => {
            puts.push(a.hex);
            return Promise.resolve(REF as never);
          },
        },
      },
    });
    await r.ready();
    // Our previous kind 0, with a field this client does not know.
    r.pool.store(
      await kit.sign(me, {
        kind: NostrKind.Profile,
        created_at: 1_700_000_000,
        tags: [],
        content: JSON.stringify({ name: 'me', website: 'https://example.com', lud16: 'me@ln' }),
      }),
    );
    const p = await r.host.adapter.setProfilePicture({ bytes: JPEG, type: 'image/jpeg' });
    expect(puts).toEqual([Buffer.from(JPEG).toString('hex')]);
    expect(p).toMatchObject({
      name: 'me',
      lud16: 'me@ln',
      picture: REF.url,
      pictureSha256: REF.sha256,
      pictureSize: REF.size,
    });
    const published = r.pool.published
      .map((x) => x.event)
      .filter((e) => e.kind === NostrKind.Profile);
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0]!.content)).toEqual({
      name: 'me',
      website: 'https://example.com',
      lud16: 'me@ln',
      picture: REF.url,
      picture_sha256: REF.sha256,
      picture_size: REF.size,
    });
    expect(nostr.verifyIncoming(published[0]!)).not.toBeNull();
  });

  it('refuses what is not an image (whatever type it claims) and too-large bytes, before the worker', async () => {
    const puts: unknown[] = [];
    r = await rig({
      flags: { devMocks: true },
      identity: new SignerIdentity(new kit.TestSigner()),
      worker: {
        handlers: {
          'profile.putImage': (a: unknown) => {
            puts.push(a);
            return Promise.resolve(REF as never);
          },
        },
      },
    });
    await r.ready();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      r.host.adapter.setProfilePicture({ bytes: svg, type: 'image/jpeg' }),
    ).rejects.toThrow(/^unsupported-input/);
    await expect(
      r.host.adapter.setProfilePicture({
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        type: 'image/jpeg',
      }),
    ).rejects.toThrow(/^invalid-argument/);
    expect(puts).toEqual([]);
  });

  it('needs a signer', async () => {
    r = await rig({ flags: { devMocks: true }, identity: new NoIdentity() });
    await r.ready();
    await expect(
      r.host.adapter.setProfilePicture({ bytes: JPEG, type: 'image/jpeg' }),
    ).rejects.toThrow(/^no-signer/);
  });
});
