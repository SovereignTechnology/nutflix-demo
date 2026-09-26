/**
 * `--dev-fixtures`: one DLEQ self-check when the worker starts (issue #8 d, ADR 0017). It shows
 * that THIS build's worker finds its DLEQ thread, and that the thread answers as core does.
 *
 * The desktop runs DLEQ checks only as a seller with real payments, and a dev or test run never
 * has those (`--dev-mocks` pays with mock proofs, which carry no DLEQ). So a build whose thread
 * entry is missing would fall back to the chunked inline path with nothing to show for it, as
 * every packaged build did before the entry was staged. The packaged-worker integration test
 * reads this line to prove the packaged layout uses the thread.
 *
 * It checks four fixed test vectors (three valid, one forged) through the same `dleqVerifier`
 * the real providers use. It waits for the thread to start, checks them again on it, stops the
 * thread, and logs ONE line: where the checks ran and whether the verdicts were right. That line
 * carries counts and two words only.
 *
 * Dev-only: loaded by `host.ts` with a dynamic `import()` behind `init.dev.fixtures`, which the
 * dev fence allows only with `--dev-mocks` on a loopback swarm (and packaged builds refuse the
 * dev flags at the command line).
 */
import type { CashuProof, MintKeyset, MintUrl } from '@sovit/core';
import { payment } from '@sovit/core';
import type { Logger } from '@sovit/seeder';

import type { DleqAnswered, SpawnDleqThread } from '../pay/dleq-thread.js';
import { dleqVerifier } from '../pay/dleq-thread.js';

/** The message the line carries (the packaged-worker test looks for it). */
export const DLEQ_SELFCHECK_MSG = 'DEV FIXTURES: DLEQ self-check';

/**
 * Test vectors, PUBLIC and worthless by design: three proofs core's in-process `mocks.TestMint`
 * issued (keys from the fixed seed 0x64 × 32, unit sat) under a mint URL in `.invalid`, which
 * exists nowhere, each with its NUT-12 DLEQ, and that test mint's public key for each amount. No
 * real mint signed them, so they redeem nowhere. They are fixed here because Bare has no
 * `crypto.getRandomValues`, which issuing needs. `__tests__/dleq-thread.test.ts` re-checks each
 * under Node with core's `proofDleqOk`.
 */
const MINT = 'https://mint.dleq-selfcheck.invalid' as MintUrl;
const KEYSET_ID = '0131c24b34102e2aa11f02a07f002e49dda446a115ae0575082b41482aedfebd30';
interface Vector {
  readonly proof: CashuProof;
  readonly dleq: NonNullable<CashuProof['dleq']>;
  readonly key: string;
}
function vector(proof: Omit<CashuProof, 'dleq'>, dleq: Vector['dleq'], key: string): Vector {
  return { proof: { ...proof, dleq }, dleq, key };
}
const FIRST: Vector = vector(
  {
    id: KEYSET_ID,
    amount: 4,
    secret: '9cf10b5a0343fe4115293fe18a168d2becf6831921a9e9c068f5bd0fa7b4a8d5',
    C: '03396d89fd2106972a91b2055625de2f9da777d13a43e6d21fedde7add6c18c05c',
  },
  {
    s: '8d2f98661f1149afdd11dff532449f1e274ad2b7e061251f2d99dfff3a3d1339',
    e: '42bfb48253d4051d9da0e7155e103041aeef36bc369e85b0f949a20d0ca7a189',
    r: '73b950f120febf802c624829d3b738abcca2dcc8bc464513e6e19efb7e65ceee',
  },
  '022aeceb65412e244d22334c139f96830aed7cc974f47c7ab2d7b54ceb18aa6ca1',
);
const VECTORS: readonly { readonly proof: CashuProof; readonly key: string }[] = [
  FIRST,
  {
    proof: {
      id: KEYSET_ID,
      amount: 2,
      secret: '125ae95d924858e48be57bc0cf5acb7a0354d8820d661a7468a2108bbc906537',
      C: '0306d9442f989a2c6d11dee51ee3616abbbcee2d3d19ee9b40cc441fa28888669d',
      dleq: {
        s: '1ffb1a51e5252c558a0ce17fbbc9bcfb096ed4a43df928ff1ad5c9fabc825700',
        e: '8069afd61f7a2e67af02b48baf616c771e6b4e7cda6293ca08cd632b1da34389',
        r: 'b124f8e1e2e749fd57df9b82dadffca9baf75ae2930afcc35d0c915ea59ab0df',
      },
    },
    key: '03cfdedc4496a4955967ee3cb5170b39f9f04f760467cb4134a7c92bf8fcbff252',
  },
  {
    proof: {
      id: KEYSET_ID,
      amount: 1,
      secret: 'e83b9c4ed7edc4ab95eb01ebcabd32a8bbe7a632068672d5a90f0051e5243078',
      C: '02c3c4d52e698a5a699ed67e78d2969aeeef6b21f3b3051eccf5b24a3333aa9e8e',
      dleq: {
        s: '31dd2ded86726db6141c3c75fae87095d654163da8b753e18ff6c94a01048cf8',
        e: '716bc64004db5f5675d44b47ad25b9b4d012238e0610d460e0c94eebfcd7ae38',
        r: '53e4acf489ab941df2f3a98f06d5b6e50b00f356d3f0fe3d02b160f50203594f',
      },
    },
    key: '0239474629cf08dffe40061843115013fdb874328250e9621acbe3b1a6ca912f61',
  },
];

function keysetFor(amount: number, key: string): MintKeyset {
  return {
    mint: MINT,
    id: KEYSET_ID,
    unit: 'sat',
    active: true,
    keys: { [amount]: key },
    fetchedAt: 0,
  };
}

/**
 * The checks, in order: the three vectors, then the first again with its DLEQ `s` changed (a
 * forged proof, which every path must refuse). `want` is the verdict each must get.
 */
export function selfCheckChecks(): {
  readonly checks: payment.DleqCheck[];
  readonly want: boolean[];
} {
  const checks: payment.DleqCheck[] = VECTORS.map((v) => ({
    proof: v.proof,
    keyset: keysetFor(v.proof.amount, v.key),
  }));
  checks.push({
    proof: { ...FIRST.proof, dleq: { ...FIRST.dleq, s: 'ab'.repeat(32) } },
    keyset: keysetFor(FIRST.proof.amount, FIRST.key),
  });
  return { checks, want: [true, true, true, false] };
}

export interface DleqSelfCheckReport {
  /** `thread` when the second pass was answered by the thread, else `inline`. */
  readonly where: 'thread' | 'inline';
  readonly answered: DleqAnswered;
  /** Both passes gave exactly `want`. */
  readonly right: boolean;
}

export interface DleqSelfCheck {
  /** The report once the check is over; `null` when it was stopped first. Never rejects. */
  readonly done: Promise<DleqSelfCheckReport | null>;
  /** Stop the check and its thread (never blocks); resolves once it is over. Idempotent. */
  close(): Promise<void>;
}

const same = (a: readonly boolean[], b: readonly boolean[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Run the check in the background and log its one line (skipped when stopped first). `verify`
 * is core's `proofDleqOk` (a test passes a wrong one to see the error line).
 */
export function startDleqSelfCheck(o: {
  readonly spawn: SpawnDleqThread;
  readonly logger: Logger;
  readonly verify?: (proof: CashuProof, keyset: MintKeyset) => boolean;
  readonly startMs?: number;
}): DleqSelfCheck {
  const v = dleqVerifier({
    spawn: o.spawn,
    verify: o.verify ?? ((p, k) => payment.proofDleqOk(p, k)),
    ...(o.startMs === undefined ? {} : { startMs: o.startMs }),
  });
  let stopped = false;
  // A named function, not an IIFE: `stopped` changes under it (TS would narrow it to `false`).
  const run = async (): Promise<DleqSelfCheckReport | null> => {
    const { checks, want } = selfCheckChecks();
    let right: boolean;
    try {
      // Pass 1 starts the thread and is answered inline meanwhile (the verifier never waits for
      // a start); pass 2 goes to the thread once it is up.
      right = same(await v.verify(checks), want);
      if (!stopped && (await v.ready())) right = same(await v.verify(checks), want) && right;
    } catch {
      right = false; // `verify` never rejects; a broken verifier is simply not right
    } finally {
      await v.close();
    }
    if (stopped) return null;
    const answered = v.answered();
    const where = answered.thread >= checks.length ? 'thread' : 'inline';
    const fields = {
      where,
      onThread: answered.thread,
      inline: answered.inline,
      checks: checks.length,
    };
    if (!right) o.logger.error(DLEQ_SELFCHECK_MSG, { ...fields, verdicts: 'wrong' });
    else if (where === 'inline')
      o.logger.warn(DLEQ_SELFCHECK_MSG, { ...fields, verdicts: 'right' });
    else o.logger.info(DLEQ_SELFCHECK_MSG, { ...fields, verdicts: 'right' });
    return { where, answered, right };
  };
  const done = run();
  return {
    done,
    close: async () => {
      stopped = true;
      await v.close();
      await done;
    },
  };
}
