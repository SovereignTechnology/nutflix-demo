/**
 * The confirm gate (design §3 "Stage 2 hook"; security review F7, F8): main asks the USER — with
 * a native dialog, outside the renderer's reach — before relaying a call that
 *
 *   - moves sats out: `wallet.melt`, `seeder.melt`, `nutzap` (`MONEY_METHODS`);
 *   - widens where money may go: an `updateSettings` patch that adds trusted mints or turns an
 *     auto top-up on (F4/F8);
 *   - publishes a file: `studio.upload`, naming the file main resolved from the SE-1 token (F7 —
 *     a compromised renderer PROCESS can mint a token for any path it knows).
 *
 * What the dialog says comes from the call's GUARDED arguments and from main's own state, never
 * from renderer-provided prose. `describe*` are pure and unit-tested; `createMoneyGate` wires them
 * to an injected `ask` (Electron's `dialog.showMessageBox` in main, a fake in tests).
 *
 * `--dev-mocks` (mock sats only) skips the money and settings questions, never the file one.
 */
import type { Method, MethodTable } from '../ipc/protocol.js';

export const MONEY_METHODS = ['wallet.melt', 'seeder.melt', 'nutzap'] as const;
export type MoneyMethod = (typeof MONEY_METHODS)[number];

export function isMoneyMethod(m: Method): m is MoneyMethod {
  return (MONEY_METHODS as readonly string[]).includes(m);
}

export type MoneyRequest = {
  [M in MoneyMethod]: { readonly wc: number; readonly method: M; readonly args: MethodTable[M][0] };
}[MoneyMethod];

type SettingsPatch = MethodTable['updateSettings'][0][0];
type SettingsValue = MethodTable['settings'][1];

/** Everything the gate may be asked about. */
export type ConfirmRequest =
  | MoneyRequest
  | {
      readonly wc: number;
      readonly method: 'updateSettings';
      readonly args: MethodTable['updateSettings'][0];
      /** The settings main last saw for this page (from a `settings` / `updateSettings` reply). */
      readonly known?: SettingsValue | undefined;
    }
  | {
      readonly wc: number;
      readonly method: 'studio.upload';
      readonly file: { readonly name: string; readonly size: number };
    };

export interface ConfirmPrompt {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  /** The label of the button that says yes; the default button is always Cancel. */
  readonly confirmLabel: string;
}

export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'ask'; readonly prompt: ConfirmPrompt };

export interface MoneyGate {
  /** `true` = relay the call; `false` = answer `forbidden`. Must never throw. */
  confirm(req: ConfirmRequest): Promise<boolean>;
}

const ALLOW: GateDecision = { kind: 'allow' };

function sats(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'sat' : 'sats'}`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 64);
  }
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${String(n)} bytes`;
}

/** Shorten an untrusted string for a dialog line (no control characters, bounded). */
function clip(s: string, max = 80): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const BOLT11_HRP = /^ln(?:bc|tb|bcrt|sb|tbs)(\d+)?([munp])?1[02-9ac-hj-np-z]+$/;

/**
 * The amount a BOLT11 invoice asks for, in whole sats, read from its human-readable part (a
 * parse, not cryptography — the signature is the mint's to check). `null` for an invoice with no
 * amount, a sub-sat amount, or anything that is not an invoice.
 */
export function bolt11AmountSats(invoice: string): number | null {
  const m = BOLT11_HRP.exec(invoice.trim().toLowerCase());
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  // Multipliers of 1 BTC = 100 000 000 sat: m = 1e-3, u = 1e-6, n = 1e-9, p = 1e-12.
  const msatPer: Record<string, number> = { m: 100_000_000, u: 100_000, n: 100, p: 0.1 };
  const msat = m[2] === undefined ? n * 100_000_000_000 : n * (msatPer[m[2]] ?? 0);
  if (!Number.isSafeInteger(msat) || msat % 1000 !== 0) return null;
  return msat / 1000;
}

/** What to ask before a money call — or why to refuse without asking. */
export function describeMoneyCall(req: MoneyRequest): GateDecision {
  switch (req.method) {
    case 'wallet.melt': {
      const [q] = req.args;
      return {
        kind: 'ask',
        prompt: {
          title: 'Pay a Lightning invoice',
          message: `Pay ${sats(q.amount)} from your wallet?`,
          detail: `Mint: ${host(q.mint)}\nUp to ${sats(q.feeReserve)} more may go to Lightning fees (unused fees come back).\nThe mint's own quote is checked before anything is paid.`,
          confirmLabel: `Pay ${sats(q.amount)}`,
        },
      };
    }
    case 'seeder.melt': {
      const [mint, bolt11] = req.args;
      const amount = bolt11AmountSats(bolt11);
      if (amount === null)
        return { kind: 'refuse', reason: 'the invoice names no whole-sat amount' };
      return {
        kind: 'ask',
        prompt: {
          title: 'Withdraw seeding earnings',
          message: `Pay ${sats(amount)} of your seeding earnings to this invoice?`,
          detail: `Mint: ${host(mint)}\nInvoice: ${clip(bolt11, 24)}…${bolt11.slice(-8)}`,
          confirmLabel: `Pay ${sats(amount)}`,
        },
      };
    }
    case 'nutzap': {
      const [videoId, amount, mint] = req.args;
      return {
        kind: 'ask',
        prompt: {
          title: 'Zap the creator',
          message: `Send ${sats(amount)} to the creator of this video?`,
          detail: `Mint: ${host(mint)}\nVideo: ${videoId.slice(0, 12)}…`,
          confirmLabel: `Send ${sats(amount)}`,
        },
      };
    }
  }
}

/**
 * What to ask before a settings patch. Only the parts that decide where the user's sats may go
 * are asked about: mints ADDED to the trusted list, and an auto top-up switched on or changed.
 * Removing mints, turning top-ups off and every other setting pass without a question.
 */
export function describeSettingsPatch(
  patch: SettingsPatch,
  known: SettingsValue | undefined,
): GateDecision {
  const lines: string[] = [];
  if (patch.defaultMints !== undefined) {
    const before = new Set(known?.defaultMints ?? []);
    const added = patch.defaultMints.filter((m) => !before.has(m));
    if (added.length > 0)
      lines.push(
        `Trust ${added.length === 1 ? 'this mint' : `these ${String(added.length)} mints`} with your sats:\n${added.map((m) => `  • ${clip(m)}`).join('\n')}`,
      );
  }
  const top = patch.autoTopUp;
  if (top !== undefined && Number.isFinite(top.belowSats) && top.belowSats > 0) {
    const was = known?.autoTopUp;
    if (was?.belowSats !== top.belowSats || was.fromMint !== top.fromMint)
      lines.push(
        `Top up automatically: whenever a trusted mint you pay from falls below ${sats(top.belowSats)}, move sats there from ${host(top.fromMint)} without asking.`,
      );
  }
  if (lines.length === 0) return ALLOW;
  return {
    kind: 'ask',
    prompt: {
      title: 'Wallet settings',
      message: 'Change where your wallet may send sats?',
      detail: lines.join('\n\n'),
      confirmLabel: 'Change settings',
    },
  };
}

/** What to ask before `studio.upload` publishes the file main resolved from the token (F7). */
export function describeUpload(file: {
  readonly name: string;
  readonly size: number;
}): GateDecision {
  return {
    kind: 'ask',
    prompt: {
      title: 'Publish a video',
      message: `Publish “${clip(file.name, 120)}” to the network?`,
      detail: `${bytes(file.size)}. Once published, anyone can fetch and keep a copy.`,
      confirmLabel: 'Publish',
    },
  };
}

export function describe(req: ConfirmRequest): GateDecision {
  if (req.method === 'studio.upload') return describeUpload(req.file);
  if (req.method === 'updateSettings') return describeSettingsPatch(req.args[0], req.known);
  return describeMoneyCall(req);
}

export interface MoneyGateOptions {
  readonly devMocks: boolean;
  /**
   * Show `prompt` as a native dialog modal to webContents `wc`; resolve `true` only for the
   * confirm button. Absent = nothing can be asked, so every question is refused (fail closed).
   */
  readonly ask?: (wc: number, prompt: ConfirmPrompt) => Promise<unknown>;
}

export function createMoneyGate(opts: MoneyGateOptions): MoneyGate {
  return {
    async confirm(req) {
      try {
        const d = describe(req);
        if (d.kind === 'allow') return true;
        if (d.kind === 'refuse') return false;
        // Mock sats only: no question for money or settings in dev mode — but a file is real.
        if (opts.devMocks && req.method !== 'studio.upload') return true;
        if (opts.ask === undefined) return false;
        return (await opts.ask(req.wc, d.prompt)) === true;
      } catch {
        return false;
      }
    },
  };
}
