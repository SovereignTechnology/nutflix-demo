/**
 * SignerManager — the host-side `SignerControl` (contracts v5, ADR 0010): connect a local key
 * (unlock / import / generate), a NIP-46 bunker or a NIP-07 extension; lock; sign out; and a
 * status feed for the Settings screen and the header.
 *
 * No key material crosses this API in either direction (L5-Settings request 1). A passphrase or
 * an nsec is collected by the injected `SecretPrompt`, handed over in a buffer this module WIPES
 * as soon as it has been used, and never returned. A NIP-46 URI is parsed by the injected
 * connector; its secret never reaches `SignerStatus`.
 *
 * Bridging this into `NetworkAdapter` and the desktop IPC table is Stage 3.
 */
import type {
  NostrPubkey,
  Signer,
  SignerConnectRequest,
  SignerControl,
  SignerStatus,
} from '../contracts/index.js';
import type { KdfCost } from './keyfile.js';
import { LocalSigner, parseSecretKey } from './local.js';
import { Nip07Signer, Nip46Signer, type BunkerLike, type Nip07Provider } from './remote.js';
import { wipe } from './secure.js';

/**
 * Collects a secret from the user through a trusted, host-owned prompt (never the renderer's
 * DOM). Resolves with the UTF-8 bytes — preferably a secure buffer — or `null` if the user
 * cancelled. The manager wipes the returned buffer after use.
 */
export interface SecretPrompt {
  ask(kind: 'unlock-passphrase' | 'new-passphrase' | 'import-nsec'): Promise<Uint8Array | null>;
}

/** Where the encrypted key file lives (the host: 0600, never in a synced folder). */
export interface KeyStore {
  read(): Promise<Uint8Array | null>;
  write(file: Uint8Array): Promise<void>;
}

export interface SignerManagerOptions {
  readonly prompt: SecretPrompt;
  readonly keyStore: KeyStore;
  /** Parse a `bunker://` URI, open the NIP-46 session and return it with its relays. */
  readonly nip46?: (
    uri: string,
  ) => Promise<{ readonly bunker: BunkerLike; readonly relays: readonly string[] }>;
  /** The page's `window.nostr`, if any (web shell only). */
  readonly nip07?: () => Nip07Provider | null | undefined;
  /** KDF cost for NEW key files (default libsodium MODERATE). Tests pass the INTERACTIVE floor. */
  readonly cost?: KdfCost;
}

const NO_SIGNER: SignerStatus = {
  kind: 'local',
  pubkey: null,
  locked: true,
  supportsSignSecret: false,
  detail: 'No signer connected',
};

async function withSecret<T>(
  prompt: SecretPrompt,
  kind: Parameters<SecretPrompt['ask']>[0],
  use: (secret: Uint8Array) => Promise<T>,
): Promise<T> {
  const secret = await prompt.ask(kind);
  if (secret === null) throw new Error('cancelled: the prompt was dismissed');
  try {
    return await use(secret);
  } finally {
    wipe(secret);
  }
}

export class SignerManager implements SignerControl {
  private signer: Signer | null = null;
  private pubkey: NostrPubkey | null = null;
  private detail: string | undefined;
  private readonly listeners = new Set<(s: SignerStatus) => void>();
  /** Serialises connect/lock/disconnect so two prompts can never race each other. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SignerManagerOptions) {}

  current(): Signer | null {
    return this.signer;
  }

  status(): SignerStatus {
    const s = this.signer;
    if (s === null) return NO_SIGNER;
    return {
      kind: s.kind,
      pubkey: this.pubkey,
      locked: s.isLocked(),
      supportsSignSecret: s.signSecret !== undefined,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }

  onStatus(cb: (s: SignerStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  connect(req: SignerConnectRequest): Promise<SignerStatus> {
    return this.serial(async () => {
      const next = await this.open(req);
      await this.dispose();
      this.signer = next.signer;
      this.pubkey = await next.signer.getPublicKey();
      this.detail = next.detail;
      return this.emit();
    });
  }

  lock(): Promise<void> {
    return this.serial(async () => {
      if (this.signer === null) return;
      await this.signer.lock();
      this.emit();
    });
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      await this.dispose();
      this.signer = null;
      this.pubkey = null;
      this.detail = undefined;
      this.emit();
    });
  }

  private async open(req: SignerConnectRequest): Promise<{ signer: Signer; detail: string }> {
    switch (req.kind) {
      case 'local':
        return this.openLocal(req.flow);
      case 'nip46': {
        if (this.o.nip46 === undefined)
          throw new Error('unsupported: NIP-46 is not available here');
        if (typeof req.uri !== 'string' || !/^(bunker|nostrconnect):\/\//.test(req.uri))
          throw new Error('invalid-argument: expected a bunker:// or nostrconnect:// URI');
        const { bunker, relays } = await this.o.nip46(req.uri);
        const signer = await Nip46Signer.adopt(bunker, relays);
        return { signer, detail: signer.detail };
      }
      case 'nip07': {
        const signer = await Nip07Signer.adopt(this.o.nip07?.());
        return { signer, detail: 'Browser extension' };
      }
    }
  }

  private async openLocal(
    flow: 'unlock' | 'import' | 'generate',
  ): Promise<{ signer: Signer; detail: string }> {
    const { prompt, keyStore } = this.o;
    const cost = this.o.cost === undefined ? {} : { cost: this.o.cost };
    if (flow === 'unlock') {
      const file = await keyStore.read();
      if (file === null) throw new Error('no-signer: there is no local key on this device yet');
      const signer = await withSecret(prompt, 'unlock-passphrase', (pw) =>
        LocalSigner.unlock(file, pw),
      );
      return { signer, detail: 'Local key (encrypted on this device)' };
    }
    const existing = await keyStore.read();
    if (existing !== null)
      throw new Error('invalid-argument: a local key already exists; unlock it or remove it first');
    const secretKey =
      flow === 'import'
        ? await withSecret(prompt, 'import-nsec', (b) => Promise.resolve(parseSecretKey(b)))
        : undefined;
    try {
      const { signer, file } = await withSecret(prompt, 'new-passphrase', (pw) =>
        LocalSigner.create({
          passphrase: pw,
          ...(secretKey === undefined ? {} : { secretKey }),
          ...cost,
        }),
      );
      await keyStore.write(file);
      return { signer, detail: 'Local key (encrypted on this device)' };
    } finally {
      wipe(secretKey);
    }
  }

  private async dispose(): Promise<void> {
    const s = this.signer;
    if (s === null) return;
    await s.lock();
    if (s instanceof Nip46Signer) await s.close();
  }

  private emit(): SignerStatus {
    const st = this.status();
    for (const cb of this.listeners) {
      try {
        cb(st);
      } catch {
        // a listener's failure is its own; the status change already happened
      }
    }
    return st;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
