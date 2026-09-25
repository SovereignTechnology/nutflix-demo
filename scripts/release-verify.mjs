#!/usr/bin/env node
// Issue #6 (security review F21, ADR 0017): verify a SIGNED desktop release event against the
// files you downloaded. Every check must pass, or it exits 1 and says which one failed:
//
//   1. the event is well-formed and its id and Schnorr signature verify (nostr-tools
//      verifyEvent — library crypto only);
//   2. it was signed by the SovTech key (npub1s0vtech…) — no other key is accepted, and there
//      is deliberately no option to accept one;
//   3. it is a desktop release notice: kind 30071, `d` = nutflix-desktop, and its `artifact`
//      tags, content (the SHA256SUMS text) and `x` (sha256 of that text) agree;
//   4. each file you name (or, with --all, every artifact of the release) is listed, and its
//      size and sha256 match.
//
// Usage:
//   node scripts/release-verify.mjs <signed-event.json> <file>...        each file must match
//   node scripts/release-verify.mjs <signed-event.json> --all <dir>      every artifact, in <dir>
//
// It reads the files and the event; it contacts nothing.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { verifyEvent } from 'nostr-tools/pure';

import {
  RELEASE_D_TAG,
  RELEASE_NOTICE_KIND,
  SAFE_NAME,
  sha256File,
  sovtechPubkeyHex,
  sumsText,
} from './release-manifest.mjs';

/** A release event is small; anything bigger is refused before it is parsed. */
export const MAX_EVENT_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export class ReleaseVerifyError extends Error {
  name = 'ReleaseVerifyError';
}
const refuse = (msg) => {
  throw new ReleaseVerifyError(msg);
};

/** The release's artifact list, from a signature-checked event (checks 1–3). */
export function checkEvent(input, expectedPubkey) {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    refuse('the event is not a JSON object');
  // Plain data only. nostr-tools' verifyEvent trusts a cached `verifiedSymbol` flag on the
  // object (set when an event is signed or verified, and COPIED by `{ ...ev }`), so an object that was
  // once verified and then edited would pass without being re-checked. A JSON round trip drops
  // every symbol and non-JSON value; the checks below then see exactly what was signed.
  let ev;
  try {
    ev = JSON.parse(JSON.stringify(input));
  } catch {
    refuse('the event is not plain JSON data');
  }
  let valid;
  try {
    // Throws on a structurally invalid event (missing fields, non-string tags).
    valid = verifyEvent(ev);
  } catch {
    valid = false;
  }
  if (!valid) refuse('bad event: its id or signature does not verify');
  if (ev.pubkey !== expectedPubkey) refuse('the event is not signed by the SovTech key');
  if (ev.kind !== RELEASE_NOTICE_KIND)
    refuse(`wrong kind ${String(ev.kind)} (want ${String(RELEASE_NOTICE_KIND)})`);
  const tag = (k) => ev.tags.filter((t) => t[0] === k);
  const one = (k) => {
    const t = tag(k);
    if (t.length !== 1 || typeof t[0][1] !== 'string')
      refuse(`the event needs exactly one "${k}" tag`);
    return t[0][1];
  };
  if (one('d') !== RELEASE_D_TAG) refuse(`not a desktop release (d = ${JSON.stringify(one('d'))})`);
  const artifacts = [];
  const seen = new Set();
  for (const t of tag('artifact')) {
    const [, name, sha256, bytes] = t;
    if (t.length !== 4 || typeof name !== 'string' || !SAFE_NAME.test(name))
      refuse('malformed artifact tag (name)');
    if (typeof sha256 !== 'string' || !HEX64.test(sha256))
      refuse(`malformed artifact tag for ${name} (sha256)`);
    if (typeof bytes !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(bytes))
      refuse(`malformed artifact tag for ${name} (size)`);
    if (seen.has(name)) refuse(`artifact ${name} is listed twice`);
    seen.add(name);
    artifacts.push({ name, sha256, bytes: Number(bytes) });
  }
  if (artifacts.length === 0) refuse('the event lists no artifacts');
  if (ev.content !== sumsText(artifacts))
    refuse('the event content does not match its artifact tags');
  if (one('x') !== createHash('sha256').update(ev.content, 'utf8').digest('hex'))
    refuse('the event x tag is not the sha256 of its content');
  if (one('files') !== String(artifacts.length))
    refuse('the files tag does not match the artifact count');
  return artifacts;
}

/**
 * Checks 1–4. `files`: paths to verify (each must be listed); or `allDir`: every listed
 * artifact must be there. `expectedPubkey` is the SovTech key in the CLI — always; tests pass a
 * throwaway key to reach the file checks.
 */
export async function verifyRelease(ev, { files, allDir, expectedPubkey }) {
  const artifacts = checkEvent(ev, expectedPubkey);
  const byName = new Map(artifacts.map((a) => [a.name, a]));
  const targets = [];
  if (allDir !== undefined) {
    for (const a of artifacts) targets.push({ path: join(allDir, a.name), a });
  } else {
    if (files.length === 0) refuse('name at least one downloaded file (or use --all <dir>)');
    for (const path of files) {
      const a = byName.get(basename(path));
      if (a === undefined) refuse(`${basename(path)} is not part of this release`);
      targets.push({ path, a });
    }
  }
  const ok = [];
  for (const { path, a } of targets) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      refuse(`${a.name} is missing`);
    }
    if (!st.isFile()) refuse(`${path} is not a regular file`);
    const got = await sha256File(path);
    if (got.bytes !== a.bytes)
      refuse(`${a.name}: size ${String(got.bytes)}, release says ${String(a.bytes)}`);
    if (got.sha256 !== a.sha256) refuse(`${a.name}: sha256 does not match the signed release`);
    ok.push(a);
  }
  return ok;
}

export async function run(argv) {
  const [eventPath, ...rest] = argv;
  if (eventPath === undefined)
    refuse('usage: release-verify.mjs <signed-event.json> (<file>... | --all <dir>)');
  let allDir;
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--all') {
      allDir = rest[++i];
      if (allDir === undefined) refuse('--all needs a directory');
    } else if (rest[i].startsWith('-')) refuse(`unknown option ${rest[i]}`);
    else files.push(rest[i]);
  }
  if (allDir !== undefined && files.length > 0) refuse('give files or --all <dir>, not both');
  if (lstatSync(eventPath).size > MAX_EVENT_BYTES) refuse('the event file is too large');
  let ev;
  try {
    ev = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    refuse('the event file is not JSON');
  }
  const ok = await verifyRelease(ev, { files, allDir, expectedPubkey: sovtechPubkeyHex() });
  for (const a of ok) process.stdout.write(`OK  ${a.sha256}  ${a.name}\n`);
  process.stdout.write(
    `release-verify: ${String(ok.length)} file(s) match the release signed by the SovTech key\n`,
  );
  return ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `release-verify: FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
