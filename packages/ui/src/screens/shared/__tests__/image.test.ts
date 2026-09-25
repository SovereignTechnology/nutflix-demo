import { describe, expect, it, vi } from 'vitest';

import type { Sha256Hex } from '@sovit/core';

import { avatarSrc, resolveImage, thumbnailSrc } from '../image.js';

const SHA = 'ab'.repeat(32) as Sha256Hex;

describe('resolveImage (T16, ADR 0015)', () => {
  it('passes exactly the arguments that are known — never an explicit undefined', async () => {
    const image = vi.fn(() => Promise.resolve('nf-media://img/x'));
    const a = { image };
    await resolveImage(a, 'https://x/a.jpg');
    await resolveImage(a, 'https://x/a.jpg', SHA);
    await resolveImage(a, 'hyper://c/0-1', SHA, 10);
    expect(image.mock.calls).toEqual([
      ['https://x/a.jpg'],
      ['https://x/a.jpg', SHA],
      ['hyper://c/0-1', SHA, 10],
    ]);
    await thumbnailSrc(a, { url: 'hyper://c/0-1', sha256: SHA, size: 7 });
    expect(image.mock.calls.at(-1)).toEqual(['hyper://c/0-1', SHA, 7]);
    await avatarSrc(a, { picture: 'hyper://c/1-1', pictureSha256: SHA, pictureSize: 9 });
    expect(image.mock.calls.at(-1)).toEqual(['hyper://c/1-1', SHA, 9]);
    expect(avatarSrc(a, { picture: '' })).toBeNull();
    expect(avatarSrc(a, null)).toBeNull();
  });
});
