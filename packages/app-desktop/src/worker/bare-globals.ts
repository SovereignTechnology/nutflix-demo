/**
 * D6, as a module: installs `bare-encoding`'s WHATWG `TextEncoder` / `TextDecoder` as
 * globals — exactly what `bare-encoding/global` does (`global.TextDecoder =
 * encoding.TextDecoder`, `global.TextEncoder = encoding.TextEncoder`), but through the
 * package's typed root export, because importing `bare-encoding/global` from TypeScript also
 * loads its `declare global` block, which redeclares `TextDecoder` for the whole worker
 * project and breaks every Node-typed test that constructs one with options.
 *
 * `./entry.ts` imports this module FIRST; ES modules evaluate in import order, so every
 * later module (`@sovit/core` builds a `TextDecoder` at load) sees the globals. Only ever
 * imported by the Bare entry: Node already has both.
 */
import { TextDecoder, TextEncoder } from 'bare-encoding';

const g = globalThis as Record<string, unknown>;
g['TextEncoder'] = TextEncoder;
g['TextDecoder'] = TextDecoder;
