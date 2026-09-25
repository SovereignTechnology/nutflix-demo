/**
 * Issue #6 (security review F21, ADR 0017): the desktop release manifest and its verifier.
 *
 * The manifest script writes SHA256SUMS, a JSON manifest and an UNSIGNED Nostr event for the
 * SovTech key; it never signs. The verifier accepts only an event whose signature verifies AND
 * whose key is the SovTech key, then checks every file's size and sha256.
 *
 * Signing here uses a THROWAWAY key generated in this process (nostr-tools), held in memory and
 * never written anywhere: the verifier CLI must refuse its events (not the SovTech key), and the
 * library entry point is called with that throwaway key only to reach the file checks.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoRoot, runNode, scriptsDir, tempDir } from './helpers.js';

interface Artifact {
  name: string;
  sha256: string;
  bytes: number;
}
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
interface VerifyLib {
  verifyRelease(
    ev: unknown,
    o: { files?: string[]; allDir?: string; expectedPubkey: string },
  ): Promise<Artifact[]>;
}
interface ManifestLib {
  sovtechPubkeyHex(): string;
  SOVTECH_NPUB: string;
  RELEASE_NOTICE_KIND: number;
}

const SOVTECH_HEX = '83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434';
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

async function lib<T>(file: string): Promise<T> {
  const path = join(scriptsDir, file);
  return (await import(/* @vite-ignore */ path)) as T;
}

/** NostrKind.ReleaseNotice from the contracts SOURCE (scripts cannot import packages/core). */
function releaseNoticeKind(): number {
  const src = readFileSync(join(repoRoot, 'packages/core/src/contracts/nostr.ts'), 'utf8');
  const m = /ReleaseNotice:\s*(\d+)/.exec(src);
  if (!m) throw new Error('NostrKind.ReleaseNotice not found');
  return Number(m[1]);
}

let dir = '';
let cleanup: () => void = () => undefined;
let make = '';
let out = '';
const files: Record<string, Buffer> = {
  'Nutflix-0.1.0-x64.AppImage': Buffer.from('appimage '.repeat(1000)),
  'nutflix_0.1.0_amd64.deb': Buffer.from('deb '.repeat(777)),
  'Nutflix-Setup.exe': Buffer.from('exe'),
};

beforeEach(() => {
  ({ dir, cleanup } = tempDir('release'));
  make = join(dir, 'make');
  out = join(dir, 'out');
  mkdirSync(join(make, 'deb', 'x64'), { recursive: true });
  mkdirSync(join(make, 'appimage', 'x64'), { recursive: true });
  mkdirSync(join(make, 'squirrel.windows', 'x64'), { recursive: true });
  writeFileSync(
    join(make, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'),
    files['Nutflix-0.1.0-x64.AppImage']!,
  );
  writeFileSync(
    join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
    files['nutflix_0.1.0_amd64.deb']!,
  );
  writeFileSync(
    join(make, 'squirrel.windows', 'x64', 'Nutflix-Setup.exe'),
    files['Nutflix-Setup.exe']!,
  );
  // Not a release artifact: skipped, and listed on stderr.
  writeFileSync(join(make, 'squirrel.windows', 'x64', 'RELEASES'), 'x');
});
afterEach(() => {
  cleanup();
});

function manifest(extra: string[] = []): ReturnType<typeof runNode> {
  return runNode('release-manifest.mjs', [
    make,
    '--out',
    out,
    '--version',
    '0.1.0',
    '--commit',
    'a'.repeat(40),
    '--created-at',
    '1790000000',
    ...extra,
  ]);
}

function unsigned(): NostrEvent {
  return JSON.parse(readFileSync(join(out, 'release-event.unsigned.json'), 'utf8')) as NostrEvent;
}

/** Signs a template with a throwaway key (in memory only) — what Bunker46 does with the real one. */
function signThrowaway(t: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>): {
  ev: NostrEvent;
  pubkey: string;
} {
  const sk = generateSecretKey();
  const ev = finalizeEvent(
    { kind: t.kind, tags: t.tags, content: t.content, created_at: t.created_at },
    sk,
  ) as unknown as NostrEvent;
  return { ev, pubkey: getPublicKey(sk) };
}

function artifactPaths(): string[] {
  return [
    join(make, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'),
    join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
    join(make, 'squirrel.windows', 'x64', 'Nutflix-Setup.exe'),
  ];
}

describe('scripts/release-manifest.mjs', () => {
  it('writes sha256sum-compatible SHA256SUMS over the release artifacts only', () => {
    const r = manifest();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/skipped \(not a release artifact\): .*RELEASES/);
    const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const expected = names.map((n) => `${sha256(files[n]!)}  ${n}\n`).join('');
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(expected);
    expect(r.stdout).toBe(expected);
    const m = JSON.parse(readFileSync(join(out, 'release-manifest.json'), 'utf8')) as {
      artifacts: Artifact[];
      version: string;
      commit: string;
      app: string;
    };
    expect(m).toMatchObject({ app: 'nutflix-desktop', version: '0.1.0', commit: 'a'.repeat(40) });
    expect(m.artifacts).toEqual(
      names.map((n) => ({ name: n, sha256: sha256(files[n]!), bytes: files[n]!.byteLength })),
    );
  });

  it('writes an UNSIGNED kind-30071 event for the SovTech key (id and sig empty)', async () => {
    expect(manifest().status).toBe(0);
    const ev = unsigned();
    const m = await lib<ManifestLib>('release-manifest.mjs');
    expect(m.sovtechPubkeyHex()).toBe(SOVTECH_HEX);
    expect(m.SOVTECH_NPUB).toBe('npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx');
    expect(m.RELEASE_NOTICE_KIND).toBe(releaseNoticeKind());
    expect(ev).toMatchObject({
      id: '',
      sig: '',
      pubkey: SOVTECH_HEX,
      kind: 30071,
      created_at: 1790000000,
    });
    expect(ev.content).toBe(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
    expect(ev.tags.slice(0, 6)).toEqual([
      ['d', 'nutflix-desktop'],
      ['version', '0.1.0'],
      ['commit', 'a'.repeat(40)],
      ['x', sha256(ev.content)],
      ['files', '3'],
      ['size', String(Object.values(files).reduce((n, b) => n + b.byteLength, 0))],
    ]);
    expect(ev.tags.filter((t) => t[0] === 'artifact')).toHaveLength(3);
  });

  it('refuses unsafe names, duplicate names, symlinks and a malformed commit', () => {
    writeFileSync(join(dir, 'bad name.deb'), 'x');
    expect(
      runNode('release-manifest.mjs', [join(dir, 'bad name.deb'), '--out', out]).stderr,
    ).toMatch(/unsafe artifact name/);
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 'nutflix_0.1.0_amd64.deb'), 'dup');
    const dup = runNode('release-manifest.mjs', [make, join(dir, 'other'), '--out', out]);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/two artifacts named nutflix_0\.1\.0_amd64\.deb/);
    symlinkSync(join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'), join(dir, 'link.deb'));
    expect(runNode('release-manifest.mjs', [join(dir, 'link.deb'), '--out', out]).stderr).toMatch(
      /symlinks/,
    );
    expect(manifest(['--commit', 'HEAD']).stderr).toMatch(/--commit must be a full 40-hex/);
  });

  it('never signs and never talks to the network (source hygiene)', () => {
    const src = readFileSync(join(scriptsDir, 'release-manifest.mjs'), 'utf8');
    for (const bad of [
      /finalizeEvent/,
      /getPublicKey/,
      /generateSecretKey/,
      /nsec1/,
      /bunker:\/\//,
      /wss:\/\//,
      /\bfetch\(/,
    ])
      expect(src).not.toMatch(bad);
    const verify = readFileSync(join(scriptsDir, 'release-verify.mjs'), 'utf8');
    for (const bad of [
      /finalizeEvent/,
      /nsec1/,
      /bunker:\/\//,
      /wss:\/\//,
      /\bfetch\(/,
      /expectedPubkey:(?!\s*sovtechPubkeyHex\(\))/,
    ])
      expect(verify).not.toMatch(bad);
  });
});

describe('scripts/release-verify.mjs', () => {
  it('the CLI REFUSES an event signed by any key but the SovTech one', () => {
    expect(manifest().status).toBe(0);
    const { ev } = signThrowaway(unsigned());
    writeFileSync(join(dir, 'signed.json'), JSON.stringify(ev));
    const r = runNode('release-verify.mjs', [join(dir, 'signed.json'), ...artifactPaths()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not signed by the SovTech key/);
    expect(r.stdout).not.toMatch(/^OK/m);
  });

  it('the CLI refuses a throwaway-signed event that claims the SovTech pubkey (signature no longer verifies)', () => {
    expect(manifest().status).toBe(0);
    const { ev } = signThrowaway(unsigned());
    writeFileSync(join(dir, 'forged.json'), JSON.stringify({ ...ev, pubkey: SOVTECH_HEX }));
    const r = runNode('release-verify.mjs', [join(dir, 'forged.json'), '--all', make]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/id or signature does not verify/);
  });

  it('the CLI refuses the unsigned template and junk', () => {
    expect(manifest().status).toBe(0);
    const u = runNode('release-verify.mjs', [
      join(out, 'release-event.unsigned.json'),
      ...artifactPaths(),
    ]);
    expect(u.status).toBe(1);
    expect(u.stderr).toMatch(/does not verify/);
    writeFileSync(join(dir, 'junk.json'), '{"not":"an event"');
    expect(
      runNode('release-verify.mjs', [join(dir, 'junk.json'), ...artifactPaths()]).stderr,
    ).toMatch(/not JSON/);
  });

  describe('file checks (reached with the throwaway key through the library entry point)', () => {
    it('accepts matching files and --all', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      expect(
        (await v.verifyRelease(ev, { files: artifactPaths(), expectedPubkey: pubkey }))
          .map((a) => a.name)
          .sort(),
      ).toEqual(Object.keys(files).sort());
      const flat = join(dir, 'downloads');
      mkdirSync(flat);
      for (const [n, b] of Object.entries(files)) writeFileSync(join(flat, n), b);
      expect(await v.verifyRelease(ev, { allDir: flat, expectedPubkey: pubkey })).toHaveLength(3);
    });

    it('refuses a changed byte, a truncated file, a file not in the release, a missing artifact', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      const deb = join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb');
      const orig = readFileSync(deb);
      const flipped = Buffer.from(orig);
      flipped[10] = flipped[10]! ^ 1;
      writeFileSync(deb, flipped);
      await expect(v.verifyRelease(ev, { files: [deb], expectedPubkey: pubkey })).rejects.toThrow(
        /sha256 does not match/,
      );
      writeFileSync(deb, orig.subarray(1));
      await expect(v.verifyRelease(ev, { files: [deb], expectedPubkey: pubkey })).rejects.toThrow(
        /size/,
      );
      writeFileSync(join(dir, 'Nutflix-9.9.9-x64.AppImage'), 'x');
      await expect(
        v.verifyRelease(ev, {
          files: [join(dir, 'Nutflix-9.9.9-x64.AppImage')],
          expectedPubkey: pubkey,
        }),
      ).rejects.toThrow(/not part of this release/);
      await expect(
        v.verifyRelease(ev, { allDir: join(dir, 'empty-nowhere'), expectedPubkey: pubkey }),
      ).rejects.toThrow(/is missing/);
      await expect(v.verifyRelease(ev, { files: [], expectedPubkey: pubkey })).rejects.toThrow(
        /at least one/,
      );
    });

    it('refuses events whose tags, content or kind disagree, and path-like artifact names', async () => {
      expect(manifest().status).toBe(0);
      const t = unsigned();
      const v = await lib<VerifyLib>('release-verify.mjs');
      const check = async (
        tpl: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
        re: RegExp,
      ): Promise<void> => {
        const { ev, pubkey } = signThrowaway(tpl);
        await expect(v.verifyRelease(ev, { allDir: make, expectedPubkey: pubkey })).rejects.toThrow(
          re,
        );
      };
      await check({ ...t, kind: 1 }, /wrong kind/);
      await check({ ...t, content: `${t.content}deadbeef  extra\n` }, /content does not match/);
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'd' ? ['d', 'nutflix-web'] : x)) },
        /not a desktop release/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'x' ? ['x', '0'.repeat(64)] : x)) },
        /x tag/,
      );
      const evil = t.tags.map((x) =>
        x[0] === 'artifact' && x[1] === 'Nutflix-Setup.exe'
          ? ['artifact', '../../etc/passwd', x[2]!, x[3]!]
          : x,
      );
      await check({ ...t, tags: evil }, /malformed artifact tag \(name\)/);
      await check(
        { ...t, tags: [...t.tags, t.tags.find((x) => x[0] === 'artifact')!] },
        /listed twice/,
      );
      // Tampering after signing breaks the signature — even on an in-process copy that still
      // carries nostr-tools' cached "verified" flag (`{ ...ev }` copies that symbol property).
      // (Found by this test: checkEvent now re-verifies plain JSON data, see there.)
      const { ev, pubkey } = signThrowaway(t);
      await expect(
        v.verifyRelease(
          { ...ev, content: ev.content.replace(/^./, 'f') },
          { allDir: make, expectedPubkey: pubkey },
        ),
      ).rejects.toThrow(/does not verify/);
    });
  });
});
