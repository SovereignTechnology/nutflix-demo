/**
 * `checkPayLock` — the P2PK lock policy for pay/1 money (ADR 0010). Adversary cases the v4
 * suite never had, because the reference model did not parse secrets: a refund path (the payer
 * can take the proof back after the locktime), extra signing keys, SIG_ALL, an unknown tag, a
 * missing / wrong / duplicated seeder binding, a non-P2PK secret, and garbage.
 */
import { describe, expect, it } from 'vitest';
import { createP2PKsecret } from '@cashu/cashu-ts';

import { checkPayLock } from '../lock.js';

const TARGET = `02${'ab'.repeat(32)}`;
const OTHER = `03${'cd'.repeat(32)}`;
const SEEDER = `02${'ef'.repeat(32)}`;

describe('checkPayLock', () => {
  it('accepts a plain lock to the target, with and without the required binding', () => {
    expect(checkPayLock(createP2PKsecret(TARGET), TARGET)).toEqual({ ok: true });
    expect(checkPayLock(createP2PKsecret(TARGET.toUpperCase()), TARGET)).toEqual({ ok: true });
    expect(
      checkPayLock(createP2PKsecret(TARGET, [['pay1', SEEDER]]), TARGET, { binding: SEEDER }),
    ).toEqual({
      ok: true,
    });
    expect(
      checkPayLock(
        createP2PKsecret(TARGET, [
          ['sigflag', 'SIG_INPUTS'],
          ['n_sigs', '1'],
        ]),
        TARGET,
      ),
    ).toEqual({
      ok: true,
    });
  });

  const cases: [string, string, { binding?: string }, string][] = [
    ['locked to someone else', createP2PKsecret(OTHER), {}, 'wrong-target'],
    ['a refund path (locktime)', createP2PKsecret(TARGET, [['locktime', '1']]), {}, 'refund-path'],
    ['a refund key', createP2PKsecret(TARGET, [['refund', OTHER]]), {}, 'refund-path'],
    ['extra signing keys', createP2PKsecret(TARGET, [['pubkeys', OTHER]]), {}, 'extra-keys'],
    ['n_sigs > 1', createP2PKsecret(TARGET, [['n_sigs', '2']]), {}, 'extra-keys'],
    ['SIG_ALL', createP2PKsecret(TARGET, [['sigflag', 'SIG_ALL']]), {}, 'sig-all'],
    ['an unknown tag', createP2PKsecret(TARGET, [['x-rule', '1']]), {}, 'unknown-tag'],
    [
      'a binding where none is expected',
      createP2PKsecret(TARGET, [['pay1', SEEDER]]),
      {},
      'unknown-tag',
    ],
    [
      'no binding where one is required',
      createP2PKsecret(TARGET),
      { binding: SEEDER },
      'missing-binding',
    ],
    [
      'a binding to another seeder',
      createP2PKsecret(TARGET, [['pay1', OTHER]]),
      { binding: SEEDER },
      'wrong-binding',
    ],
    [
      'a binding with two values',
      createP2PKsecret(TARGET, [['pay1', SEEDER, OTHER]]),
      { binding: SEEDER },
      'wrong-binding',
    ],
    ['an HTLC', JSON.stringify(['HTLC', { nonce: 'aa', data: 'bb'.repeat(32) }]), {}, 'not-p2pk'],
    ['a plain secret', 'a'.repeat(64), {}, 'malformed'],
    ['garbage JSON', '["P2PK",', {}, 'malformed'],
  ];
  for (const [name, secret, opts, reason] of cases) {
    it(`refuses ${name} (${reason})`, () => {
      expect(checkPayLock(secret, TARGET, opts)).toEqual({ ok: false, reason });
    });
  }

  it('refuses duplicate tag keys (cashu-ts parse) and a malformed target', () => {
    const dup = JSON.stringify([
      'P2PK',
      {
        nonce: 'aa',
        data: TARGET,
        tags: [
          ['pay1', SEEDER],
          ['pay1', SEEDER],
        ],
      },
    ]);
    expect(checkPayLock(dup, TARGET, { binding: SEEDER }).ok).toBe(false);
    expect(checkPayLock(createP2PKsecret(TARGET), 'ab'.repeat(32))).toEqual({
      ok: false,
      reason: 'wrong-target',
    });
  });
});
