import * as fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { mocks } from '@sovit/core';
import type { MintUrl, Sats, SeederStatus } from '@sovit/core';

import type { SeederStatusWire, WireMap } from '../protocol.js';
import { dehydrate, fromWireMap, rehydrate, toWireMap } from '../wiremap.js';
import type { Dehydrated } from '../wiremap.js';

describe('WireMap', () => {
  it('toWireMap / fromWireMap round-trip, order kept', () => {
    const m = new Map([
      ['b', 2],
      ['a', 1],
    ]);
    const w = toWireMap(m);
    expect(w).toEqual({
      $map: [
        ['b', 2],
        ['a', 1],
      ],
    });
    expect([...fromWireMap(w)]).toEqual([...m]);
  });

  it('dehydrate / rehydrate the real SeederStatus and analytics results', async () => {
    const adapter = new mocks.MockNetworkAdapter();
    const status = await adapter.seeder.status();
    const wire = dehydrate(status);
    expectTypeOf(wire).toEqualTypeOf<Dehydrated<SeederStatus>>();
    expectTypeOf<Dehydrated<SeederStatus>>().toExtend<SeederStatusWire>();
    // survives JSON (worker hop) and structured clone (Electron hop)
    const back = rehydrate(JSON.parse(JSON.stringify(wire)) as SeederStatusWire);
    expect(back).toEqual(status);
    expect(back.earned.byMint).toBeInstanceOf(Map);
    expect(rehydrate(structuredClone(wire))).toEqual(status);

    const analytics = await adapter.studio.analytics(mocks.VIDEOS[0]!.id);
    expect(rehydrate(dehydrate(analytics))).toEqual(analytics);
  });

  it('leaves bytes, primitives and non-plain objects alone; never mutates input', () => {
    const bytes = new Uint8Array([1, 2]);
    const input = { bytes, n: 1, s: 's', nil: null, arr: [1, { $map: [['k', 'v']] }] };
    const frozen = structuredClone(input);
    const out = rehydrate(input);
    expect(out.bytes).toBe(bytes);
    expect(out.arr[1]).toEqual(new Map([['k', 'v']]));
    expect(input).toEqual(frozen);
  });

  it('only an object whose ONLY key is $map with string-keyed pairs is a WireMap', () => {
    expect(rehydrate({ $map: [['a', 1]], other: 1 })).toEqual({ $map: [['a', 1]], other: 1 });
    expect(rehydrate({ $map: [[1, 1]] })).toEqual({ $map: [[1, 1]] });
    expect(rehydrate({ $map: 'x' })).toEqual({ $map: 'x' });
  });

  it('a "__proto__" key stays a data property on the copy', () => {
    const parsed = JSON.parse(
      '{"__proto__":{"polluted":true},"a":{"$map":[["__proto__",1]]}}',
    ) as object;
    const out = rehydrate(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect((out['a'] as Map<string, number>).get('__proto__')).toBe(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('refuses non-string Map keys and runaway depth (cycles included)', () => {
    expect(() => dehydrate({ m: new Map([[1, 1]]) })).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => dehydrate(cyc)).toThrow(RangeError);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => rehydrate(deep)).toThrow(RangeError);
  });

  it('property: rehydrate(dehydrate(x)) equals x for nested Maps/objects/arrays', () => {
    const { tree } = fc.letrec((tie) => ({
      tree: fc.oneof(
        { depthSize: 'small' },
        fc.jsonValue({ maxDepth: 1 }),
        fc.array(tie('tree'), { maxLength: 3 }),
        fc.dictionary(
          fc.string().filter((k) => k !== '$map'),
          tie('tree'),
          { maxKeys: 3 },
        ),
        fc.array(fc.tuple(fc.string(), tie('tree')), { maxLength: 3 }).map((es) => new Map(es)),
      ),
    }));
    fc.assert(
      fc.property(tree, (x) => {
        const wire = dehydrate(x);
        expect(rehydrate(JSON.parse(JSON.stringify(wire)) as unknown)).toEqual(
          JSON.parse(
            JSON.stringify(x, (_k, v: unknown) => (v instanceof Map ? { __m: [...v] } : v)),
            (_k, v: unknown) =>
              v !== null && typeof v === 'object' && '__m' in v
                ? new Map((v as { __m: [string, unknown][] }).__m)
                : v,
          ),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('types: Rehydrated<WireMap<K, V>> is ReadonlyMap<K, V>', () => {
    const w: WireMap<MintUrl, Sats> = { $map: [] };
    expectTypeOf(rehydrate(w)).toEqualTypeOf<ReadonlyMap<MintUrl, Sats>>();
  });
});
