import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { media, mocks } from '@sovit/core';

import { INTERNAL_MESSAGE, fromWireError, toWireError, wireError } from '../errors.js';
import type { IpcError } from '../errors.js';
import { isWireError } from '../guards.js';
import { ERROR_CODES, LIMITS } from '../protocol.js';
import type { ErrorCode } from '../protocol.js';

/** The real screen classifiers, imported from @sovit/ui source (its root export has React). */
async function uiClassifiers(): Promise<{
  playErrorKind(e: unknown): string;
  shortsPlayErrorKind(e: unknown): string;
  classifyStudioError(e: unknown): string;
}> {
  const load = async (rel: string): Promise<Record<string, unknown>> =>
    (await import(
      /* @vite-ignore */ new URL(`../../../../ui/src/screens/${rel}`, import.meta.url).href
    )) as Record<string, unknown>;
  const watch = await load('Watch/model.ts');
  const shorts = await load('Shorts/Shorts.tsx');
  const studio = await load('Studio/model.ts');
  return {
    playErrorKind: watch['playErrorKind'] as (e: unknown) => string,
    shortsPlayErrorKind: shorts['shortsPlayErrorKind'] as (e: unknown) => string,
    classifyStudioError: studio['classifyStudioError'] as (e: unknown) => string,
  };
}

/** One hop: sender's toWireError → structured clone (Electron IPC) → receiver's fromWireError. */
const hop = (err: unknown): IpcError => fromWireError(structuredClone(toWireError(err)));

/** What MockNetworkAdapter actually throws, and what core's media pipeline throws. */
async function realErrors(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const capture = async (k: string, p: Promise<unknown>): Promise<void> => {
    try {
      await p;
      out[k] = new Error(`${k}: did not reject`);
    } catch (e) {
      out[k] = e;
    }
  };
  const id = mocks.VIDEOS[0]!.id;
  await capture('no-seeders', new mocks.MockNetworkAdapter({ failWith: 'no-seeders' }).play(id));
  await capture('no-balance', new mocks.MockNetworkAdapter({ failWith: 'no-balance' }).play(id));
  await capture(
    'relay-down',
    new mocks.MockNetworkAdapter({ failWith: 'relay-down' }).feed({ source: 'trending' }),
  );
  out['ffmpeg-not-found'] = new media.MediaError(
    'ffmpeg-not-found',
    'probe: could not spawn /opt/ff/bin/ffprobe (ENOENT)',
    {
      cause: new media.ProcessRunnerError('spawn-failed', '/opt/ff/bin/ffprobe', {
        errno: 'ENOENT',
      }),
    },
  );
  out['spawn-failed'] = new media.ProcessRunnerError('spawn-failed', '/usr/bin/ffmpeg', {
    errno: 'ENOENT',
  });
  out['no-signer'] = new Error('no-signer: signer not detected');
  return out;
}

describe('toWireError / fromWireError', () => {
  it('every prefix the screens classify by survives the hop — checked with the real classifiers', async () => {
    const ui = await uiClassifiers();
    const errs = await realErrors();
    for (const k of ['no-seeders', 'no-balance', 'relay-down'] as const) {
      const original = errs[k];
      const rebuilt = hop(original);
      expect(rebuilt.message.startsWith(`${k}: `), rebuilt.message).toBe(true);
      expect(rebuilt.code).toBe(k);
      expect(ui.playErrorKind(rebuilt)).toBe(ui.playErrorKind(original));
      expect(ui.shortsPlayErrorKind(rebuilt)).toBe(ui.shortsPlayErrorKind(original));
      expect(ui.playErrorKind(rebuilt)).toBe(k);
    }
    const signer = hop(errs['no-signer']);
    expect(signer.message.startsWith('no-signer: ')).toBe(true);
    expect(ui.shortsPlayErrorKind(signer)).toBe('no-signer');
    expect(ui.classifyStudioError(signer)).toBe('no-signer');
    for (const k of ['ffmpeg-not-found', 'spawn-failed'] as const) {
      const rebuilt = hop(errs[k]);
      expect(rebuilt.code).toBe('ffmpeg-not-found');
      expect(rebuilt.message.startsWith('ffmpeg-not-found: ')).toBe(true);
      expect(ui.classifyStudioError(rebuilt)).toBe('ffmpeg-not-found');
      // …and the path of the binary does not leave the process.
      expect(rebuilt.message).not.toMatch(/\/opt\/ff|\/usr\/bin/);
    }
  });

  it('keeps media codes (Studio reads .code)', async () => {
    const ui = await uiClassifiers();
    const cases: [media.MediaErrorCode, string][] = [
      ['unsupported-input', 'unsupported-input'],
      ['no-video-stream', 'no-video-stream'],
      ['process-failed', 'process-failed'],
      ['probe-parse', 'process-failed'],
      ['not-faststart', 'verification-failed'],
      ['hash-mismatch', 'verification-failed'],
      ['aborted', 'aborted'],
    ];
    for (const [code, kind] of cases) {
      const rebuilt = hop(
        new media.MediaError(code, `transcode 720p: ${code}`, { stderr: 'secret stderr' }),
      );
      expect(rebuilt.code).toBe(code);
      expect(rebuilt.message).not.toContain('secret stderr');
      expect(ui.classifyStudioError(rebuilt)).toBe(kind);
    }
  });

  it('maps a code found on a cause, a plain {code} object and a bare string', () => {
    expect(
      toWireError(new Error('wrapper', { cause: new Error('relay-down: all 3 relays') })).code,
    ).toBe('relay-down');
    expect(toWireError({ code: 'rate-limited', message: 'slow down' })).toEqual({
      code: 'rate-limited',
      message: 'rate-limited: slow down',
    });
    expect(toWireError('not-found: video')).toEqual({
      code: 'not-found',
      message: 'not-found: video',
    });
    expect(toWireError(new Error('no-signer'))).toEqual({
      code: 'no-signer',
      message: 'no-signer: no-signer',
    });
  });

  it('unknown errors become `internal` with a constant message — no stack, no path, no detail', () => {
    const e = new Error('ENOENT: no such file /home/cam/.ssh/id_ed25519');
    for (const x of [
      e,
      new TypeError('x is undefined'),
      new Error('video not found'),
      { message: 'no-seedersX: close but no' },
      42,
      null,
      undefined,
      Symbol('s'),
      { code: 'EACCES' },
    ]) {
      expect(toWireError(x)).toEqual({ code: 'internal', message: INTERNAL_MESSAGE });
    }
  });

  it('scrubs paths but keeps URLs, and clamps the length', () => {
    const w = toWireError(
      new Error(
        'no-balance: at https://mint.example/v1 (see /home/cam/wallet.db, C:\\Users\\cam\\w.db, file:///x)',
      ),
    );
    expect(w.message).toBe('no-balance: at https://mint.example/v1 (see <path>, <path>, <path>)');
    const long = toWireError(new Error(`relay-down: ${'x'.repeat(5000)}`));
    expect(long.message.length).toBeLessThanOrEqual(LIMITS.maxErrorMessage);
    expect(isWireError(long)).toBe(true);
    const multi = toWireError(new Error('relay-down: first line\n    at secret (/app/x.js:1:1)'));
    expect(multi.message).toBe('relay-down: first line');
  });

  it('fromWireError: malformed envelopes become internal; valid ones keep code + prefix', () => {
    expect(fromWireError({ code: 'no-seeders', message: 'no-seeders: x' })).toMatchObject({
      code: 'no-seeders',
      message: 'no-seeders: x',
    });
    for (const bad of [
      null,
      {},
      { code: 'no-seeders', message: 'x' },
      { code: 'nope', message: 'nope: x' },
      'no-seeders: x',
    ])
      expect(fromWireError(bad)).toMatchObject({ code: 'internal', message: INTERNAL_MESSAGE });
    expect(fromWireError({ code: 'forbidden', message: 'forbidden: x' })).toBeInstanceOf(Error);
  });

  it('wireError(code, detail) always yields a valid WireError', () => {
    for (const code of ERROR_CODES) {
      expect(isWireError(wireError(code, 'detail'))).toBe(true);
      expect(isWireError(wireError(code, ''))).toBe(true);
    }
    expect(wireError('forbidden', 'wallet.send is not available to the renderer').message).toBe(
      'forbidden: wallet.send is not available to the renderer',
    );
  });

  it('fuzz: never throws, always yields a valid WireError whose message starts "<code>: "', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.string().map((s) => new Error(s)),
          fc
            .tuple(fc.constantFrom<ErrorCode>(...ERROR_CODES), fc.string())
            .map(([c, s]) => new Error(`${c}: ${s}`)),
          fc
            .tuple(fc.constantFrom<ErrorCode>(...ERROR_CODES), fc.string())
            .map(([code, message]) => ({ code, message })),
        ),
        (x) => {
          const w = toWireError(x);
          expect(isWireError(w)).toBe(true);
          const back = fromWireError(structuredClone(w));
          expect(back.message.startsWith(`${back.code}: `)).toBe(true);
          expect(back.code).toBe(w.code);
        },
      ),
      { numRuns: 500 },
    );
  });
});
