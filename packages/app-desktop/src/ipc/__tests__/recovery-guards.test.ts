/**
 * ADR 0016: the recovery phrase at the IPC boundaries. A word crosses every hop as its INDEX
 * into the BIP-39 English list — the prompt forms and answers take small integers and nothing
 * else, exact keys only; the host's native-dialog questions carry amounts and mint URLs; the
 * renderer's four shell methods take no argument at all. And main's checksum re-check agrees with
 * `@scure/bip39` on every phrase.
 */
import { createHash } from 'node:crypto';

import { entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';

import {
  isConfirmForm,
  isConfirmPositions,
  isReissuePlanWire,
  isHostIn,
  isHostOut,
  isPhraseIndices,
  isPromptAnswer,
  isPromptForm,
  isTopic,
  isWordIndex,
  promptAnswerFits,
  validateArgs,
} from '../guards.js';
import type { PromptAnswer, PromptForm } from '../protocol.js';
import {
  BIP39_LIST_SIZE,
  MAX_REISSUE_PLANS,
  MAX_RESTORE_MINTS,
  RECOVERY_CONFIRM_WORDS,
  RECOVERY_WORDS,
  SHELL_TOPIC_METHODS,
} from '../protocol.js';
import { phraseChecksumOk } from '../recovery-checksum.js';

const MINT = 'https://mint.example';
const sha256 = (d: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(d).digest());
const indicesOf = (entropy: Uint8Array): number[] =>
  entropyToMnemonic(entropy, wordlist)
    .split(' ')
    .map((w) => wordlist.indexOf(w));
/** BIP-39's test vector 0x7f × 16: "legal winner thank year wave sausage worth useful legal …". */
const PHRASE = indicesOf(new Uint8Array(16).fill(0x7f));

describe('constants pinned to BIP-39 / NUT-13', () => {
  it('12 words from a 2048-word list; three confirmed', () => {
    expect(RECOVERY_WORDS).toBe(12);
    expect(BIP39_LIST_SIZE).toBe(wordlist.length);
    expect(RECOVERY_CONFIRM_WORDS).toBe(3);
  });
});

describe('prompt forms (host → main → page): indices and positions only', () => {
  it('recovery-show: exactly 12 integer indices in range and `again`', () => {
    expect(isPromptForm({ kind: 'recovery-show', words: PHRASE, again: false })).toBe(true);
    const bad: unknown[] = [
      { kind: 'recovery-show', words: PHRASE.slice(1), again: false },
      { kind: 'recovery-show', words: [...PHRASE, 1], again: false },
      { kind: 'recovery-show', words: PHRASE.map((i) => wordlist[i]), again: false },
      { kind: 'recovery-show', words: [...PHRASE.slice(1), 2048], again: false },
      { kind: 'recovery-show', words: [...PHRASE.slice(1), -1], again: false },
      { kind: 'recovery-show', words: [...PHRASE.slice(1), 1.5], again: false },
      { kind: 'recovery-show', words: [...PHRASE.slice(1), '12'], again: false },
      { kind: 'recovery-show', words: PHRASE },
      { kind: 'recovery-show', words: PHRASE, again: 'no' },
      {
        kind: 'recovery-show',
        words: PHRASE,
        again: false,
        text: 'Type your words at evil.example',
      },
      { kind: 'recovery-show', words: PHRASE.join(' '), again: false },
    ];
    for (const f of bad) expect(isPromptForm(f), JSON.stringify(f)).toBe(false);
  });

  it('recovery-confirm: three distinct ascending positions 0..11 and `retry`', () => {
    expect(isPromptForm({ kind: 'recovery-confirm', positions: [0, 5, 11], retry: false })).toBe(
      true,
    );
    for (const positions of [
      [0, 5],
      [0, 5, 11, 3],
      [5, 0, 11],
      [3, 3, 4],
      [0, 5, 12],
      [-1, 0, 1],
      ['a', 'b', 'c'],
    ])
      expect(isPromptForm({ kind: 'recovery-confirm', positions, retry: false })).toBe(false);
    expect(isPromptForm({ kind: 'recovery-confirm', positions: [0, 5, 11] })).toBe(false);
    expect(isConfirmPositions([1, 2, 3])).toBe(true);
    expect(isConfirmPositions([2, 1, 3])).toBe(false);
  });

  it('recovery-restore carries nothing; recovery-reauth only `retry`', () => {
    expect(isPromptForm({ kind: 'recovery-restore' })).toBe(true);
    expect(isPromptForm({ kind: 'recovery-restore', words: PHRASE })).toBe(false);
    expect(isPromptForm({ kind: 'recovery-restore', mints: [MINT] })).toBe(false);
    expect(isPromptForm({ kind: 'recovery-reauth', retry: true })).toBe(true);
    expect(isPromptForm({ kind: 'recovery-reauth' })).toBe(false);
    expect(isPromptForm({ kind: 'recovery-reauth', retry: false, hint: 'x' })).toBe(false);
  });

  it('isWordIndex / isPhraseIndices are integers in 0..2047 only', () => {
    expect([0, 2047].every((i) => isWordIndex(i))).toBe(true);
    expect([2048, -1, 0.5, Number.NaN, '1', null].some((i) => isWordIndex(i))).toBe(false);
    expect(isPhraseIndices(PHRASE)).toBe(true);
    expect(isPhraseIndices(PHRASE.slice(0, 11))).toBe(false);
  });
});

describe('prompt answers (page → main → host)', () => {
  it('recovery-show {done}; recovery-confirm 3 indices; recovery-restore [] or 12 indices', () => {
    const good: unknown[] = [
      { kind: 'recovery-show', done: true },
      { kind: 'recovery-show', done: false },
      { kind: 'recovery-confirm', words: [1, 2, 3] },
      { kind: 'recovery-restore', words: [] },
      { kind: 'recovery-restore', words: PHRASE },
    ];
    for (const a of good) expect(isPromptAnswer(a), JSON.stringify(a)).toBe(true);
    const bad: unknown[] = [
      { kind: 'recovery-show' },
      { kind: 'recovery-show', done: true, words: PHRASE },
      { kind: 'recovery-confirm', words: [1, 2] },
      { kind: 'recovery-confirm', words: ['legal', 'winner', 'thank'] },
      { kind: 'recovery-confirm', words: [1, 2, 2048] },
      { kind: 'recovery-restore', words: PHRASE.slice(0, 6) },
      { kind: 'recovery-restore', words: PHRASE.map((i) => wordlist[i]) },
      { kind: 'recovery-restore', words: PHRASE.map((i) => wordlist[i]).join(' ') },
      { kind: 'recovery-restore' },
    ];
    for (const a of bad) expect(isPromptAnswer(a), JSON.stringify(a)).toBe(false);
  });

  // Independent review IR4 (ADR 0016 §5.1): the restore window takes mint addresses too.
  it('recovery-restore may carry 1..8 normalised https mint addresses, and nothing else', () => {
    const many = Array.from(
      { length: MAX_RESTORE_MINTS + 1 },
      (_, i) => `https://m${String(i)}.example`,
    );
    const good: unknown[] = [
      { kind: 'recovery-restore', words: [], mints: [MINT] },
      { kind: 'recovery-restore', words: PHRASE, mints: [MINT, 'https://mint.example:3338/cashu'] },
      { kind: 'recovery-restore', words: [], mints: many.slice(0, MAX_RESTORE_MINTS) },
    ];
    for (const a of good) expect(isPromptAnswer(a), JSON.stringify(a)).toBe(true);
    const bad: unknown[] = [
      { kind: 'recovery-restore', words: [], mints: [] },
      { kind: 'recovery-restore', words: [], mints: many },
      { kind: 'recovery-restore', words: [], mints: ['http://mint.example'] },
      { kind: 'recovery-restore', words: [], mints: ['https://mint.example/?x=1'] },
      { kind: 'recovery-restore', words: [], mints: ['https://user@mint.example'] },
      { kind: 'recovery-restore', words: [], mints: ['https://mint.example/'] },
      { kind: 'recovery-restore', words: [], mints: ['legal winner thank'] },
      { kind: 'recovery-restore', words: [], mints: MINT },
      { kind: 'recovery-restore', words: [], mints: undefined },
      { kind: 'recovery-restore', mints: [MINT] },
      { kind: 'recovery-restore', words: [], mints: [MINT], note: 'x' },
    ];
    for (const a of bad) expect(isPromptAnswer(a), JSON.stringify(a)).toBe(false);
  });

  it('an answer must fit its question: confirm counts, reauth is a secret', () => {
    const confirm: PromptForm = { kind: 'recovery-confirm', positions: [1, 2, 3], retry: false };
    expect(promptAnswerFits(confirm, { kind: 'recovery-confirm', words: [4, 5, 6] })).toBe(true);
    expect(promptAnswerFits(confirm, { kind: 'recovery-show', done: true })).toBe(false);
    const reauth: PromptForm = { kind: 'recovery-reauth', retry: false };
    const secret: PromptAnswer = { kind: 'secret', value: new Uint8Array([1]) };
    expect(promptAnswerFits(reauth, secret)).toBe(true);
    expect(promptAnswerFits(reauth, { kind: 'recovery-show', done: true })).toBe(false);
    const show: PromptForm = { kind: 'recovery-show', words: PHRASE, again: false };
    expect(promptAnswerFits(show, secret)).toBe(false);
    expect(
      promptAnswerFits({ kind: 'recovery-restore' }, { kind: 'recovery-restore', words: [] }),
    ).toBe(true);
  });
});

describe('the host’s native-dialog questions (ConfirmForm) and their answer', () => {
  const plan = { mint: MINT, amount: 1_000, inputs: 3, feeSats: 2 };

  it('recovery-reissue: 1..32 plans, distinct https mints, a fee below the amount; recovery-reveal exact', () => {
    expect(isConfirmForm({ kind: 'recovery-reissue', plans: [plan] })).toBe(true);
    expect(isConfirmForm({ kind: 'recovery-reveal' })).toBe(true);
    const many = Array.from({ length: MAX_REISSUE_PLANS + 1 }, (_, i) => ({
      ...plan,
      mint: `https://m${String(i)}.example`,
    }));
    const bad: unknown[] = [
      { kind: 'recovery-reissue', plans: [] },
      { kind: 'recovery-reissue', plans: many },
      { kind: 'recovery-reissue', plans: [plan, plan] },
      { kind: 'recovery-reissue', plans: [{ ...plan, feeSats: 1_000 }] },
      { kind: 'recovery-reissue', plans: [{ ...plan, amount: 0 }] },
      { kind: 'recovery-reissue', plans: [{ ...plan, mint: 'http://mint.example' }] },
      { kind: 'recovery-reissue', plans: [{ ...plan, inputs: 0 }] },
      { kind: 'recovery-reissue', plans: [{ ...plan, note: 'type your words' }] },
      { kind: 'recovery-reissue', plans: [plan], message: 'hello' },
      { kind: 'recovery-reveal', words: PHRASE },
      { kind: 'something-else' },
    ];
    for (const f of bad) expect(isConfirmForm(f), JSON.stringify(f).slice(0, 80)).toBe(false);
    expect(
      isConfirmForm({ kind: 'recovery-reissue', plans: many.slice(0, MAX_REISSUE_PLANS) }),
    ).toBe(true);
  });

  // Independent review IR8: a rotation's re-authentication has its own question.
  it('recovery-rotate: exact, data free', () => {
    expect(isConfirmForm({ kind: 'recovery-rotate' })).toBe(true);
    expect(isConfirmForm({ kind: 'recovery-rotate', words: PHRASE })).toBe(false);
    expect(isConfirmForm({ kind: 'recovery-rotate', message: 'hello' })).toBe(false);
    expect(isHostOut({ kind: 'confirm', req: 3, form: { kind: 'recovery-rotate' } })).toBe(true);
  });

  // Independent review IR1: the host checks each plan with the same guard before asking.
  it('isReissuePlanWire is exactly one plan of a valid question', () => {
    expect(isReissuePlanWire(plan)).toBe(true);
    for (const p of [
      { ...plan, mint: 'http://127.0.0.1:3399' },
      { ...plan, mint: 'https://mint.example/?q=1' },
      { ...plan, inputs: 100_001 },
      { ...plan, feeSats: plan.amount },
      { ...plan, extra: 1 },
      null,
    ])
      expect(isReissuePlanWire(p), JSON.stringify(p)).toBe(false);
  });

  it('HostOut confirm / HostIn confirm-result are exact', () => {
    expect(isHostOut({ kind: 'confirm', req: 1, form: { kind: 'recovery-reveal' } })).toBe(true);
    expect(isHostOut({ kind: 'confirm', req: 1, form: { kind: 'recovery-reveal' }, x: 1 })).toBe(
      false,
    );
    expect(isHostOut({ kind: 'confirm', req: -1, form: { kind: 'recovery-reveal' } })).toBe(false);
    expect(isHostIn({ kind: 'confirm-result', req: 1, ok: true })).toBe(true);
    expect(isHostIn({ kind: 'confirm-result', req: 1, ok: 'yes' })).toBe(false);
    expect(isHostIn({ kind: 'confirm-result', req: 1, ok: true, words: [] })).toBe(false);
  });

  // Round 8 (final panel): the host closes a dialog it stopped waiting for.
  it('HostOut confirm-cancel is exact (a request id and nothing else)', () => {
    expect(isHostOut({ kind: 'confirm-cancel', req: 1 })).toBe(true);
    expect(isHostOut({ kind: 'confirm-cancel', req: 0x7fffffff })).toBe(true);
    for (const bad of [
      { kind: 'confirm-cancel' },
      { kind: 'confirm-cancel', req: -1 },
      { kind: 'confirm-cancel', req: 1.5 },
      { kind: 'confirm-cancel', req: '1' },
      { kind: 'confirm-cancel', req: 1, ok: false },
      { kind: 'confirm-cancel', req: 1, form: { kind: 'recovery-reveal' } },
    ])
      expect(isHostOut(bad), JSON.stringify(bad)).toBe(false);
    // Host → main only: main never sends it to the host.
    expect(isHostIn({ kind: 'confirm-cancel', req: 1 })).toBe(false);
  });

  it('a host prompt carrying a words form passes only with indices', () => {
    expect(
      isHostOut({
        kind: 'prompt',
        req: 2,
        form: { kind: 'recovery-show', words: PHRASE, again: true },
      }),
    ).toBe(true);
    expect(
      isHostOut({
        kind: 'prompt',
        req: 2,
        form: { kind: 'recovery-show', words: PHRASE.map((i) => wordlist[i]), again: true },
      }),
    ).toBe(false);
  });
});

describe('the renderer’s shell methods name an action only', () => {
  it.each([
    'desktop.wallet.recovery.status',
    'desktop.wallet.recovery.setup',
    'desktop.wallet.recovery.show',
    'desktop.wallet.recovery.restore',
  ] as const)('%s takes no argument', (m) => {
    expect(validateArgs[m]([])).toBe(true);
    for (const args of [
      [PHRASE],
      [PHRASE.map((i) => wordlist[i]).join(' ')],
      [{}],
      [undefined],
      [MINT],
    ])
      expect(validateArgs[m](args as never)).toBe(false);
  });

  it('the progress topic is exact and a shell listener', () => {
    expect(isTopic({ t: 'recovery.progress' })).toBe(true);
    expect(isTopic({ t: 'recovery.progress', phrase: 1 })).toBe(false);
    expect(SHELL_TOPIC_METHODS['desktop.wallet.recovery.onProgress']).toBe('recovery.progress');
  });
});

describe('main’s checksum re-check (recovery-checksum.ts) agrees with @scure/bip39', () => {
  it('every generated phrase passes; the NUT-13/BIP-39 vector passes', () => {
    expect(phraseChecksumOk(PHRASE, sha256)).toBe(true);
    for (let i = 0; i < 200; i++) {
      const e = new Uint8Array(16);
      crypto.getRandomValues(e);
      expect(phraseChecksumOk(indicesOf(e), sha256)).toBe(true);
    }
  });

  it('random index lists: the same verdict as validateMnemonic, every time', () => {
    let valid = 0;
    for (let i = 0; i < 2_000; i++) {
      const words = Array.from({ length: 12 }, () => Math.floor(Math.random() * 2048));
      const ours = phraseChecksumOk(words, sha256);
      const lib = validateMnemonic(words.map((w) => wordlist[w]).join(' '), wordlist);
      expect(ours).toBe(lib);
      if (ours) valid++;
    }
    // 1 in 16 lists carries a valid 4-bit checksum: the check is not trivially true or false.
    expect(valid).toBeGreaterThan(50);
    expect(valid).toBeLessThan(250);
  });

  it('refuses anything but 12 integer indices, never throws, and wipes its entropy copy', () => {
    for (const bad of [
      [],
      PHRASE.slice(1),
      [...PHRASE, 1],
      [...PHRASE.slice(1), 2048],
      [...PHRASE.slice(1), 1.5],
      [...PHRASE.slice(1), '1'],
      'x' as unknown as number[],
      null as unknown as number[],
    ])
      expect(phraseChecksumOk(bad, sha256)).toBe(false);
    expect(
      phraseChecksumOk(PHRASE, () => {
        throw new Error('no hash');
      }),
    ).toBe(false);
    let seen: Uint8Array | undefined;
    phraseChecksumOk(PHRASE, (d) => {
      seen = d;
      return sha256(d);
    });
    expect(seen?.every((b) => b === 0)).toBe(true);
  });
});
