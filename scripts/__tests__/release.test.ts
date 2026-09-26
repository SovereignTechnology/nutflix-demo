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
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
    o: { files?: string[]; allDir?: string; trustedPubkey?: string },
  ): Promise<{ version: string; commit?: string; createdAt: number; files: Artifact[] }>;
  MAX_EVENT_BYTES: number;
}
interface ManifestLib {
  sovtechPubkeyHex(): string;
  SOVTECH_NPUB: string;
  RELEASE_NOTICE_KIND: number;
  MADE_LIST_SCHEMA: string;
  MADE_LIST_SUFFIX: string;
  DEFAULT_OUT: string;
  parseArgs(argv: string[]): { out: string };
  nameCarriesVersion(name: string, version: string): boolean;
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
// Every artifact name carries the release version (independent review of the packaging lane:
// the manifest refuses a name without it, so the Setup.exe is now versioned too).
const files: Record<string, Buffer> = {
  'Nutflix-0.1.0-x64.AppImage': Buffer.from('appimage '.repeat(1000)),
  'nutflix_0.1.0_amd64.deb': Buffer.from('deb '.repeat(777)),
  'Nutflix-0.1.0-Setup.exe': Buffer.from('exe'),
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
    join(make, 'squirrel.windows', 'x64', 'Nutflix-0.1.0-Setup.exe'),
    files['Nutflix-0.1.0-Setup.exe']!,
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
    join(make, 'squirrel.windows', 'x64', 'Nutflix-0.1.0-Setup.exe'),
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
    // --version: the names must now carry it (the default is app-desktop's own version).
    const dup = runNode('release-manifest.mjs', [
      make,
      join(dir, 'other'),
      '--out',
      out,
      '--version',
      '0.1.0',
    ]);
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
      // The CLI never picks the trusted key: verifyRelease's default (SovTech) applies.
      /trustedPubkey:/,
    ])
      expect(verify).not.toMatch(bad);
  });
});

/** A made list as packaging/cli.ts writes it (relative to its own directory). */
function madeList(file: string, version: string, artifacts: string[]): string {
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'nutflix-made/1',
      platform: 'linux',
      arch: 'x64',
      version,
      artifacts,
    }),
  );
  return file;
}

describe('scripts/release-manifest.mjs — one release, only this make (independent review)', () => {
  it('created_at is NOW by default, never SOURCE_DATE_EPOCH (a re-made manifest must be newer on the relays)', () => {
    const before = Math.floor(Date.now() / 1000);
    const r = runNode(
      'release-manifest.mjs',
      [make, '--out', out, '--version', '0.1.0', '--commit', 'a'.repeat(40)],
      { env: { SOURCE_DATE_EPOCH: '1700000000' } },
    );
    expect(r.status, r.stderr).toBe(0);
    const ev = unsigned();
    expect(ev.created_at).toBeGreaterThanOrEqual(before);
    expect(ev.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const src = readFileSync(join(scriptsDir, 'release-manifest.mjs'), 'utf8');
    expect(src).not.toMatch(/env\.SOURCE_DATE_EPOCH/);
  });

  it('refuses an artifact whose name does not carry the version (a stale one in out/make)', () => {
    writeFileSync(join(make, 'appimage', 'x64', 'Nutflix-0.0.9-x64.AppImage'), 'old build');
    const r = manifest();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Nutflix-0\.0\.9-x64\.AppImage does not carry version 0\.1\.0/);
    expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
  });

  it('nameCarriesVersion matches the version as a whole field only', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    for (const n of [
      'Nutflix-0.1.0-x64.AppImage',
      'nutflix_0.1.0_amd64.deb',
      'Nutflix-0.1.0-Setup.exe',
      'Nutflix-0.1.0-arm64.dmg',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(true);
    for (const n of [
      'Nutflix-Setup.exe',
      'Nutflix-0.1.01-x64.AppImage',
      'Nutflix-10.1.0-x64.AppImage',
      'Nutflix-0x1x0-x64.AppImage',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(false);
    expect(m.nameCarriesVersion('a-0.1.0-x.deb', '0.1.0 ')).toBe(false);
  });

  it('--made takes exactly the artifacts that make produced; a stale file beside them is ignored', () => {
    writeFileSync(join(make, 'appimage', 'x64', 'Nutflix-0.0.9-x64.AppImage'), 'old build');
    const list = madeList(join(make, 'linux-x64.artifacts.json'), '0.1.0', [
      'deb/x64/nutflix_0.1.0_amd64.deb',
      'appimage/x64/Nutflix-0.1.0-x64.AppImage',
      'squirrel.windows/x64/RELEASES',
    ]);
    const r = runNode('release-manifest.mjs', [
      '--made',
      list,
      '--out',
      out,
      '--version',
      '0.1.0',
      '--commit',
      'a'.repeat(40),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/skipped \(not a release artifact\): .*RELEASES/);
    expect(
      unsigned()
        .tags.filter((t) => t[0] === 'artifact')
        .map((t) => t[1]),
    ).toEqual(['Nutflix-0.1.0-x64.AppImage', 'nutflix_0.1.0_amd64.deb']);
  });

  it('--made refuses a list for another version, an empty or foreign list, and paths that escape it', () => {
    const run = (content: string): ReturnType<typeof runNode> => {
      const f = join(make, 'x.artifacts.json');
      writeFileSync(f, content);
      return runNode('release-manifest.mjs', ['--made', f, '--out', out, '--version', '0.1.0']);
    };
    const base = { schema: 'nutflix-made/1', platform: 'linux', arch: 'x64', version: '0.1.0' };
    expect(
      run(
        JSON.stringify({
          ...base,
          version: '0.0.9',
          artifacts: ['deb/x64/nutflix_0.1.0_amd64.deb'],
        }),
      ).stderr,
    ).toMatch(/made for version "0\.0\.9", not 0\.1\.0/);
    expect(run(JSON.stringify({ ...base, artifacts: [] })).stderr).toMatch(/lists no artifacts/);
    expect(run(JSON.stringify({ ...base, schema: 'x', artifacts: ['a'] })).stderr).toMatch(
      /is not a nutflix-made\/1 list/,
    );
    expect(run('{').stderr).toMatch(/is not JSON/);
    for (const bad of [
      '../make/deb/x64/nutflix_0.1.0_amd64.deb',
      '/etc/passwd',
      'deb\\x64\\a.deb',
      'deb//a.deb',
      './deb/a.deb',
    ])
      expect(run(JSON.stringify({ ...base, artifacts: [bad] })).stderr, bad).toMatch(
        /bad artifact path/,
      );
    // A list naming a symlink is refused like any other input.
    symlinkSync(
      join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
      join(make, 'nutflix_0.1.0_link.deb'),
    );
    expect(run(JSON.stringify({ ...base, artifacts: ['nutflix_0.1.0_link.deb'] })).stderr).toMatch(
      /symlinks/,
    );
  });

  it('--out defaults to packages/app-desktop/out/release (gitignored), never the working directory', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    expect(m.DEFAULT_OUT).toBe(join(repoRoot, 'packages', 'app-desktop', 'out', 'release'));
    expect(m.parseArgs([make]).out).toBe(m.DEFAULT_OUT);
    expect(readFileSync(join(repoRoot, '.gitignore'), 'utf8')).toMatch(
      /^packages\/app-desktop\/out\/$/m,
    );
  });

  it('the made-list schema and suffix are the ones packaging/cli.ts writes', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    const identity = (await import(
      /* @vite-ignore */ join(repoRoot, 'packages', 'app-desktop', 'packaging', 'identity.ts')
    )) as { MADE_LIST_SCHEMA: string; MADE_LIST_SUFFIX: string; RELEASE_D_TAG: string };
    expect(m.MADE_LIST_SCHEMA).toBe(identity.MADE_LIST_SCHEMA);
    expect(m.MADE_LIST_SUFFIX).toBe(identity.MADE_LIST_SUFFIX);
    expect(identity.RELEASE_D_TAG).toBe('nutflix-desktop');
  });

  it('the CI makes ONE release event, after every platform job (kind 30071 is addressable)', () => {
    const ci = readFileSync(
      join(repoRoot, 'packages', 'app-desktop', 'packaging', 'ci', 'release.gitlab-ci.yml'),
      'utf8',
    );
    const code = ci
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const runs = code.match(/release-manifest\.mjs[^\n]*(?:\n\s+--[^\n]*)*/g) ?? [];
    expect(runs).toHaveLength(1);
    for (const list of ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'])
      expect(runs[0], list).toContain(
        `--made packages/app-desktop/out/make/${list}.artifacts.json`,
      );
    expect(code).toMatch(
      /^desktop-release-manifest:\n(?: {2}.*\n)*? {2}needs: \[desktop-linux, desktop-macos, desktop-windows\]\n/m,
    );
    // …and it is the job that runs it: the only script line naming release-manifest.mjs.
    const job = /^desktop-release-manifest:\n((?: {2}.*\n|\s*\n)*)/m.exec(code)?.[1] ?? '';
    expect(job).toContain('release-manifest.mjs');
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

  it('the CLI refuses an oversized event file (bytes read, symlink measured by its target) and a device', async () => {
    expect(manifest().status).toBe(0);
    const v = await lib<VerifyLib>('release-verify.mjs');
    const big = join(dir, 'big.json');
    writeFileSync(big, `{"pad":"${'x'.repeat(v.MAX_EVENT_BYTES)}"}`);
    const r = runNode('release-verify.mjs', [big, ...artifactPaths()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/event file is too large/);
    symlinkSync(big, join(dir, 'small-looking.json'));
    expect(
      runNode('release-verify.mjs', [join(dir, 'small-looking.json'), ...artifactPaths()]).stderr,
    ).toMatch(/event file is too large/);
    if (existsSync('/dev/zero'))
      expect(runNode('release-verify.mjs', ['/dev/zero', ...artifactPaths()]).stderr).toMatch(
        /not a regular file/,
      );
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
    it('the library defaults to the SovTech key and refuses a malformed trusted key', async () => {
      expect(manifest().status).toBe(0);
      const { ev } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      await expect(v.verifyRelease(ev, { files: artifactPaths() })).rejects.toThrow(
        /not signed by the SovTech key/,
      );
      for (const bad of ['', 'ab', 'Z'.repeat(64)])
        await expect(
          v.verifyRelease(ev, { files: artifactPaths(), trustedPubkey: bad }),
        ).rejects.toThrow(/trusted key must be a 64-hex/);
    });

    it('accepts matching files and --all', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      expect(
        (await v.verifyRelease(ev, { files: artifactPaths(), trustedPubkey: pubkey })).files
          .map((a) => a.name)
          .sort(),
      ).toEqual(Object.keys(files).sort());
      const flat = join(dir, 'downloads');
      mkdirSync(flat);
      for (const [n, b] of Object.entries(files)) writeFileSync(join(flat, n), b);
      const all = await v.verifyRelease(ev, { allDir: flat, trustedPubkey: pubkey });
      expect(all.files).toHaveLength(3);
      // What was verified is reported: an old genuine release verifies too (no "latest").
      expect(all).toMatchObject({ version: '0.1.0', createdAt: 1790000000 });
    });

    it('reports the commit; refuses a symlinked download (never follows it to other bytes)', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      const deb = join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb');
      expect(await v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).toMatchObject({
        commit: 'a'.repeat(40),
      });
      const dl = join(dir, 'dl');
      mkdirSync(dl);
      symlinkSync(deb, join(dl, 'nutflix_0.1.0_amd64.deb'));
      await expect(
        v.verifyRelease(ev, {
          files: [join(dl, 'nutflix_0.1.0_amd64.deb')],
          trustedPubkey: pubkey,
        }),
      ).rejects.toThrow(/is not a regular file/);
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
      await expect(v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).rejects.toThrow(
        /sha256 does not match/,
      );
      writeFileSync(deb, orig.subarray(1));
      await expect(v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).rejects.toThrow(
        /size/,
      );
      writeFileSync(join(dir, 'Nutflix-9.9.9-x64.AppImage'), 'x');
      await expect(
        v.verifyRelease(ev, {
          files: [join(dir, 'Nutflix-9.9.9-x64.AppImage')],
          trustedPubkey: pubkey,
        }),
      ).rejects.toThrow(/not part of this release/);
      await expect(
        v.verifyRelease(ev, { allDir: join(dir, 'empty-nowhere'), trustedPubkey: pubkey }),
      ).rejects.toThrow(/is missing/);
      await expect(v.verifyRelease(ev, { files: [], trustedPubkey: pubkey })).rejects.toThrow(
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
        await expect(v.verifyRelease(ev, { allDir: make, trustedPubkey: pubkey })).rejects.toThrow(
          re,
        );
      };
      await check({ ...t, kind: 1 }, /wrong kind/);
      await check(
        { ...t, tags: t.tags.filter((x) => x[0] !== 'version') },
        /exactly one "version" tag/,
      );
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
        x[0] === 'artifact' && x[1] === 'Nutflix-0.1.0-Setup.exe'
          ? ['artifact', '../../etc/passwd', x[2]!, x[3]!]
          : x,
      );
      await check({ ...t, tags: evil }, /malformed artifact tag \(name\)/);
      await check(
        { ...t, tags: [...t.tags, t.tags.find((x) => x[0] === 'artifact')!] },
        /listed twice/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'files' ? ['files', '2'] : x)) },
        /files tag does not match the artifact count/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'size' ? ['size', '1'] : x)) },
        /size tag does not match/,
      );
      await check({ ...t, tags: t.tags.filter((x) => x[0] !== 'size') }, /exactly one "size" tag/);
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'commit' ? ['commit', 'HEAD'] : x)) },
        /malformed commit tag/,
      );
      await check({ ...t, tags: [...t.tags, ['commit', 'b'.repeat(40)]] }, /more than one commit/);
      // Tampering after signing breaks the signature — even on an in-process copy that still
      // carries nostr-tools' cached "verified" flag (`{ ...ev }` copies that symbol property).
      // (Found by this test: checkEvent now re-verifies plain JSON data, see there.)
      const { ev, pubkey } = signThrowaway(t);
      await expect(
        v.verifyRelease(
          { ...ev, content: ev.content.replace(/^./, 'f') },
          { allDir: make, trustedPubkey: pubkey },
        ),
      ).rejects.toThrow(/does not verify/);
    });
  });
});
