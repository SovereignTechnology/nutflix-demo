/**
 * `portable.ts` is what the desktop Bare worker loads (the `bare` export condition). Bare
 * resolves `node:*` as npm packages, so nothing reachable from it may import a Node builtin,
 * and it must never reach the daemon CLI (`cli/main.ts`: `node:fs/promises`, `node:util`),
 * the Node adapters or `index.ts` (whose main-module guard uses `node:fs`/`node:url`).
 *
 * Static walk of the VALUE import graph under `src/` (type-only imports are erased by tsc
 * and ignored here); external packages are leaves. A positive control walks `index.ts` and
 * must find what `portable.ts` must not, so the walker cannot pass vacuously.
 */
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATIC_RE =
  /(?:^|\n)[ \t]*(import|export)[ \t]+(type[ \t]+)?(?:[^'";]*?[ \t\n]from[ \t]+)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function isBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  const top = spec.split('/')[0] ?? spec;
  return builtinModules.includes(top);
}

interface Graph {
  readonly files: Set<string>;
  readonly external: Map<string, string>; // specifier → first importer (relative)
}

async function walk(entry: string): Promise<Graph> {
  const files = new Set<string>();
  const external = new Map<string, string>();
  const queue = [path.join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = await readFile(file, 'utf8');
    const specs: string[] = [];
    for (const m of text.matchAll(STATIC_RE)) if (m[2] === undefined) specs.push(m[3]!);
    for (const m of text.matchAll(DYNAMIC_RE)) specs.push(m[1]!);
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      } else if (!external.has(spec)) external.set(spec, path.relative(SRC, file));
    }
  }
  return { files, external };
}

const rel = (g: Graph): string[] => [...g.files].map((f) => path.relative(SRC, f)).sort();

describe('portable.ts (bare export condition) import hygiene', () => {
  it('reaches no Node builtin, no daemon CLI, no Node adapter and not index.ts', async () => {
    const g = await walk('portable.ts');
    const files = rel(g);
    // The walker really walked: the portable daemon runner and melt CLI are in it.
    expect(files).toEqual(expect.arrayContaining(['cli/daemon.ts', 'cli/melt.ts', 'seeder.ts']));
    expect(files.length).toBeGreaterThan(15);

    const builtins = [...g.external].filter(([spec]) => isBuiltin(spec));
    expect(builtins).toEqual([]);
    expect(
      files.filter(
        (f) =>
          f === 'index.ts' ||
          f === 'cli/main.ts' ||
          f === 'cli/providers.ts' ||
          f.startsWith('runtime/') ||
          f.startsWith('adapters/node/'),
      ),
    ).toEqual([]);
  });

  it('positive control: index.ts does reach cli/main.ts, the Node adapters and node: builtins', async () => {
    const g = await walk('index.ts');
    expect(rel(g)).toEqual(
      expect.arrayContaining([
        'cli/main.ts',
        'cli/config-file.ts',
        'adapters/node/index.ts',
        'runtime/index.ts',
      ]),
    );
    expect([...g.external.keys()]).toEqual(
      expect.arrayContaining(['node:fs', 'node:url', 'node:util', 'node:fs/promises']),
    );
  });
});
