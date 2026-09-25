/**
 * `src/ipc/` runs in every process, including the Bare worker (Bare 1.31: no TextEncoder,
 * TextDecoder, crypto, AbortController, process). These checks keep it that way; the sidecar
 * test (src/types/__tests__/sidecar.test.ts) proves it under the real `bare` binary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const IPC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = readdirSync(IPC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, src: readFileSync(join(IPC_DIR, f), 'utf8') }));

/** Source without comments and string/template/regex contents (keeps the code tokens). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('src/ipc boundaries', () => {
  it('has the expected modules', () => {
    // Issue #6 (ADR 0017) added `asar-path.ts`: a string-only helper main and the host share to
    // find the unpacked tree of a packaged build; it is held to the same rules as the rest.
    expect(sources.map((s) => s.f).sort()).toEqual([
      'asar-path.ts',
      'codec.ts',
      'errors.ts',
      'framing.ts',
      'guards.ts',
      'index.ts',
      'protocol.ts',
      'wiremap.ts',
      'worker-guards.ts',
      'worker-protocol.ts',
    ]);
  });

  it.each(sources.map((s) => [s.f, s.src] as const))(
    '%s: imports only ./ modules at runtime and only TYPES from @sovit/core',
    (_f, src) => {
      const imports = [...src.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
      for (const [stmt, , isType, spec] of imports) {
        if (spec === undefined) continue;
        if (spec.startsWith('./')) continue;
        expect(spec, stmt).toBe('@sovit/core');
        expect(
          isType,
          `runtime import from the @sovit/core root barrel (loads nostr-tools): ${stmt}`,
        ).toBe('type ');
      }
      expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    },
  );

  it.each(sources.map((s) => [s.f, code(s.src)] as const))(
    '%s: uses no global Bare lacks (or that is Node/Electron-only)',
    (_f, c) => {
      for (const re of [
        /\bTextEncoder\b/,
        /\bTextDecoder\b/,
        /\bcrypto\b/,
        /\bAbortController\b/,
        /\bprocess\b/,
        /\bBuffer\b/,
        /\bBare\b/,
        /\bglobalThis\b/,
        /\bwindow\b/,
        /\bdocument\b/,
        /\bfetch\b/,
        /\bnew URL\b/,
        /\bsetTimeout\b|\bsetInterval\b/,
      ])
        expect(c).not.toMatch(re);
    },
  );
});
