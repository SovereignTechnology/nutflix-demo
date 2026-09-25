#!/usr/bin/env node
// Issue #6 (security review F21, ADR 0017): the desktop release manifest.
//
// Writes, for a set of release artifacts (the .deb, .AppImage, .dmg, Setup.exe …):
//   SHA256SUMS                   `sha256sum -c` compatible: `<sha256>  <name>\n`, names sorted
//   release-manifest.json        name, bytes and sha256 of each artifact, version, commit
//   release-event.unsigned.json  an UNSIGNED Nostr event (NIP-01) for the SovTech key: kind
//                                30071 (NostrKind.ReleaseNotice), `d` = nutflix-desktop,
//                                content = the SHA256SUMS text, one `artifact` tag per file
//
// Nothing here signs, holds a key, or talks to a relay or a bunker. The event is signed later,
// by Cameron, through the SovTech key's NIP-46 signer (Bunker46); `id` and `sig` stay empty
// until then. scripts/release-verify.mjs checks a signed event against downloaded files.
//
// Event shape (verified field by field by release-verify.mjs):
//   kind       30071
//   pubkey     SOVTECH_PUBKEY_HEX (the signer sets/keeps it; a different key fails verify)
//   tags       ["d","nutflix-desktop"] ["version",v] ["commit",sha]? ["x",sha256(content)]
//              ["files",n] ["size",total] then ["artifact",name,sha256,bytes] per file
//   content    the SHA256SUMS text
//
// Only node:crypto sha256 and nostr-tools' nip19 decoder are used (no crypto of our own).
//
// Usage:
//   node scripts/release-manifest.mjs <artifact|dir>... [--out <dir>] [--version <v>]
//        [--commit <sha>] [--created-at <unix>]
//   A directory contributes every file under it with a release extension (.deb .AppImage
//   .dmg .exe .msix .zip .rpm); anything else is skipped (and listed on stderr).
//   --out defaults to the current directory; --version to @sovit/app-desktop's version;
//   --commit to `git rev-parse HEAD`; --created-at to $SOURCE_DATE_EPOCH, else now.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decode } from 'nostr-tools/nip19';

/** = NostrKind.ReleaseNotice (contracts v3); pinned to the contract by a test. */
export const RELEASE_NOTICE_KIND = 30071;
export const RELEASE_D_TAG = 'nutflix-desktop';
/** The SovTech org key (Cameron, 2026-09-24): every release is signed by it, nothing else. */
export const SOVTECH_NPUB = 'npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx';

/** The SovTech key as hex, decoded with nostr-tools (a test pins the value). */
export function sovtechPubkeyHex() {
  const d = decode(SOVTECH_NPUB);
  if (d.type !== 'npub' || typeof d.data !== 'string')
    throw new Error('SOVTECH_NPUB is not an npub');
  return d.data;
}

export const RELEASE_EXTENSIONS = ['.deb', '.AppImage', '.dmg', '.exe', '.msix', '.zip', '.rpm'];

/**
 * Artifact names end up in `sha256sum` lines, event tags and file lookups: no path separators,
 * no whitespace or control characters, no leading dot, bounded.
 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** Bytewise order (LC_ALL=C), so the sums text is reproducible. */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function sha256File(path) {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/** Expands the positional inputs into artifact paths; symlinks and odd entries are refused. */
export function collectArtifacts(inputs, skipped = []) {
  const out = [];
  const visit = (p, fromDir) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`symlinks are not release artifacts: ${p}`);
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort(byteOrder)) visit(join(p, e), true);
      return;
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    if (fromDir && !RELEASE_EXTENSIONS.some((x) => p.endsWith(x))) {
      skipped.push(p);
      return;
    }
    out.push(resolve(p));
  };
  for (const i of inputs) visit(i, false);
  return out;
}

export function sumsText(artifacts) {
  return [...artifacts]
    .sort((a, b) => byteOrder(a.name, b.name))
    .map((a) => `${a.sha256}  ${a.name}\n`)
    .join('');
}

/** The unsigned NIP-01 event: `id` and `sig` empty until the SovTech signer fills them. */
export function unsignedEvent({ artifacts, version, commit, createdAt }) {
  const sorted = [...artifacts].sort((a, b) => byteOrder(a.name, b.name));
  const content = sumsText(sorted);
  const tags = [
    ['d', RELEASE_D_TAG],
    ['version', version],
  ];
  if (commit) tags.push(['commit', commit]);
  tags.push(
    ['x', createHash('sha256').update(content, 'utf8').digest('hex')],
    ['files', String(sorted.length)],
    ['size', String(sorted.reduce((n, a) => n + a.bytes, 0))],
  );
  for (const a of sorted) tags.push(['artifact', a.name, a.sha256, String(a.bytes)]);
  return {
    id: '',
    pubkey: sovtechPubkeyHex(),
    created_at: createdAt,
    kind: RELEASE_NOTICE_KIND,
    tags,
    content,
    sig: '',
  };
}

export async function buildManifest(paths, { version, commit, createdAt }) {
  if (paths.length === 0) throw new Error('no release artifacts given');
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version))
    throw new Error('--version must be a plain version string');
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit))
    throw new Error('--commit must be a full 40-hex git sha');
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('bad created_at');
  const seen = new Set();
  const artifacts = [];
  for (const p of paths) {
    const name = basename(p);
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe artifact name: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`two artifacts named ${name}`);
    seen.add(name);
    artifacts.push({ name, ...(await sha256File(p)) });
  }
  artifacts.sort((a, b) => byteOrder(a.name, b.name));
  return {
    manifest: {
      schema: 'nutflix-release/1',
      app: RELEASE_D_TAG,
      version,
      ...(commit ? { commit } : {}),
      createdAt,
      artifacts,
    },
    sums: sumsText(artifacts),
    event: unsignedEvent({ artifacts, version, commit, createdAt }),
  };
}

function parseArgs(argv) {
  const o = { inputs: [], out: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out') o.out = next();
    else if (a === '--version') o.version = next();
    else if (a === '--commit') o.commit = next();
    else if (a === '--created-at') o.createdAt = Number(next());
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

/** Default `--version`: @sovit/app-desktop's package.json (what Forge names the artifacts by). */
function desktopVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, '..', 'packages', 'app-desktop', 'package.json'), 'utf8'),
  ).version;
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export async function run(argv, env = process.env) {
  const o = parseArgs(argv);
  const skipped = [];
  const paths = collectArtifacts(o.inputs, skipped);
  for (const s of skipped)
    process.stderr.write(`release-manifest: skipped (not a release artifact): ${s}\n`);
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const createdAt =
    o.createdAt ??
    (Number.isSafeInteger(epoch) && epoch > 0 ? epoch : Math.floor(Date.now() / 1000));
  const { manifest, sums, event } = await buildManifest(paths, {
    version: o.version ?? desktopVersion(),
    commit: o.commit ?? gitHead(),
    createdAt,
  });
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'SHA256SUMS'), sums);
  writeFileSync(join(o.out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(o.out, 'release-event.unsigned.json'), `${JSON.stringify(event, null, 2)}\n`);
  process.stdout.write(sums);
  process.stderr.write(
    `release-manifest: ${String(manifest.artifacts.length)} artifacts -> ${resolve(o.out)} ` +
      '(release-event.unsigned.json is UNSIGNED: sign it with the SovTech key through Bunker46, never here)\n',
  );
  return { manifest, sums, event };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`release-manifest: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
