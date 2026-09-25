/**
 * `adapter.image` with exactly the arguments that are known (T16; ADR 0015): a `hyper://` image —
 * a thumbnail or avatar in a creator's profile core, read over Pear — needs its sha256 AND size;
 * any other image passes what it has, and nothing is passed as an explicit `undefined`.
 */
import type { NetworkAdapter, Profile, Rendition, Sha256Hex } from '@sovit/core';

type ImageAdapter = Pick<NetworkAdapter, 'image'>;

export function resolveImage(
  adapter: ImageAdapter,
  url: string,
  sha256?: Sha256Hex,
  size?: number,
): Promise<string> {
  if (size !== undefined) return adapter.image(url, sha256, size);
  if (sha256 !== undefined) return adapter.image(url, sha256);
  return adapter.image(url);
}

/** A rendition's thumbnail. */
export function thumbnailSrc(
  adapter: ImageAdapter,
  image: NonNullable<Rendition['image']>,
): Promise<string> {
  return resolveImage(adapter, image.url, image.sha256, image.size);
}

/** A profile's picture, or `null` when it has none. */
export function avatarSrc(
  adapter: ImageAdapter,
  p: Pick<Profile, 'picture' | 'pictureSha256' | 'pictureSize'> | null | undefined,
): Promise<string> | null {
  if (p?.picture === undefined || p.picture === '') return null;
  return resolveImage(adapter, p.picture, p.pictureSha256, p.pictureSize);
}
