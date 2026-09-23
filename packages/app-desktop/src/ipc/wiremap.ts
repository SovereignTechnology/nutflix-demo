/**
 * `ReadonlyMap` ⇄ `WireMap` (`{ $map: [[k, v], …] }`). Structured clone through
 * `contextBridge` is not trusted to carry Maps (design §2, risk 5) and JSON cannot, so the
 * host `dehydrate`s results/payloads before they leave it and the renderer (`renderer/adapter/
 * rehydrate.ts`) `rehydrate`s them before the screens see them.
 *
 * No contract type has a property named `$map`, so an object whose ONLY own key is `$map`
 * holding an array of pairs is unambiguous. Pure: no globals beyond `Map`/`Array`.
 */
import type { Rehydrated, WireMap } from './protocol.js';
import { LIMITS } from './protocol.js';

export type { Rehydrated };

/** `ReadonlyMap` → `WireMap`, recursively (the inverse of `Rehydrated`). */
export type Dehydrated<T> =
  T extends ReadonlyMap<infer K extends string, infer V>
    ? WireMap<K, Dehydrated<V>>
    : T extends string | number | boolean | bigint | symbol | null | undefined | Uint8Array
      ? T
      : T extends readonly (infer U)[]
        ? readonly Dehydrated<U>[]
        : T extends object
          ? { [P in keyof T]: Dehydrated<T[P]> }
          : T;

export function toWireMap<K extends string, V>(m: ReadonlyMap<K, V>): WireMap<K, V> {
  return { $map: [...m.entries()] };
}

export function fromWireMap<K extends string, V>(w: WireMap<K, V>): ReadonlyMap<K, V> {
  return new Map(w.$map.map(([k, v]) => [k, v] as const));
}

function isPlain(x: object): boolean {
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function isWireMapShape(x: object): x is WireMap<string, unknown> {
  const keys = Object.keys(x);
  if (keys.length !== 1 || keys[0] !== '$map') return false;
  const list: unknown = (x as { $map: unknown }).$map;
  return (
    Array.isArray(list) &&
    list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string')
  );
}

/**
 * A copy of a plain object with mapped values. `defineProperty`, not assignment: a JSON-parsed
 * own key `__proto__` must stay a data property instead of replacing the copy's prototype.
 */
function copyObject(x: object, f: (v: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x))
    Object.defineProperty(out, k, {
      value: f(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

function tooDeep(): never {
  throw new RangeError(`wiremap: nesting deeper than ${LIMITS.maxDepth}`);
}

/**
 * Every `Map` (string keys only) → `WireMap`, recursively through plain objects and arrays.
 * Other values are returned as they are. Throws `TypeError` on a non-string Map key and
 * `RangeError` past `LIMITS.maxDepth` (which also stops cycles).
 */
export function dehydrate<T>(value: T): Dehydrated<T> {
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > LIMITS.maxDepth) tooDeep();
    if (typeof x !== 'object' || x === null || ArrayBuffer.isView(x)) return x;
    if (x instanceof Map) {
      const entries: [string, unknown][] = [];
      for (const [k, v] of x as Map<unknown, unknown>) {
        if (typeof k !== 'string') throw new TypeError('wiremap: Map keys must be strings');
        entries.push([k, walk(v, depth + 1)]);
      }
      return { $map: entries };
    }
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (!isPlain(x)) return x;
    return copyObject(x, (v) => walk(v, depth + 1));
  };
  return walk(value, 0) as Dehydrated<T>;
}

/**
 * Every `WireMap` → `Map`, recursively through plain objects and arrays (the renderer's
 * rebuild). Returns new containers; never mutates its input. Throws `RangeError` past
 * `LIMITS.maxDepth`.
 */
export function rehydrate<T>(value: T): Rehydrated<T> {
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > LIMITS.maxDepth) tooDeep();
    if (typeof x !== 'object' || x === null || ArrayBuffer.isView(x)) return x;
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (!isPlain(x)) return x;
    if (isWireMapShape(x)) return new Map(x.$map.map(([k, v]) => [k, walk(v, depth + 1)] as const));
    return copyObject(x, (v) => walk(v, depth + 1));
  };
  return walk(value, 0) as Rehydrated<T>;
}
