/**
 * The daemon's identity: a `LocalSigner` key file (argon2id + XChaCha20-Poly1305, `@sovit/core`
 * signer) holding the node's Nostr key — HELLO, nutzaps, kind 10019 — and its wallet P2PK key,
 * which redeems what viewers lock to it.
 *
 * The passphrase is a systemd credential (`LoadCredentialEncrypted=seeder-key-passphrase`), read
 * from `$CREDENTIALS_DIRECTORY` — never the environment, the config file or argv (build-plan §7
 * "Keys at rest: argon2id-derived passphrase key; never env vars"). A credential lives on a
 * private ramfs visible to this service only, and an encrypted one is sealed to the host.
 *
 * Nothing here logs; errors name paths and problems, never the key or the passphrase.
 */
import { randomFillSync } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { signer as signerMod } from '@sovit/core';
import type { CashuP2pkPubkey, NostrPubkey } from '@sovit/core';

import { RuntimeSetupError, assertPrivate } from './files.js';

/** The systemd credential id the unit loads the key passphrase under. */
export const PASSPHRASE_CREDENTIAL = 'seeder-key-passphrase';
/** Anything shorter is not a credential anyone should seal a money key under. */
export const MIN_PASSPHRASE_BYTES = 16;
const MAX_PASSPHRASE_BYTES = 4096;
const MAX_KEY_FILE_BYTES = 64 * 1024;

export interface NodeIdentity {
  readonly signer: signerMod.LocalSigner;
  readonly pubkey: NostrPubkey;
  /** The wallet key's P2PK pubkey: HELLO's `p2pk`, the kind 10019 `pubkey`. */
  readonly p2pk: CashuP2pkPubkey;
}

/** Drop ONE trailing newline (`echo … | systemd-creds encrypt` adds one); keep the rest verbatim. */
function stripNewline(b: Uint8Array): Uint8Array {
  let n = b.length;
  if (n > 0 && b[n - 1] === 0x0a) n--;
  if (n > 0 && b[n - 1] === 0x0d) n--;
  return b.subarray(0, n);
}

/**
 * Read the passphrase credential. The returned buffer is the caller's to wipe (`fill(0)`).
 * `credentialsDirectory` is `$CREDENTIALS_DIRECTORY`, which systemd sets only when the unit
 * loads at least one credential.
 */
export async function readPassphrase(credentialsDirectory: string | undefined): Promise<Buffer> {
  if (credentialsDirectory === undefined || credentialsDirectory === '')
    throw new RuntimeSetupError(
      `no systemd credentials: the key passphrase is the credential ${PASSPHRASE_CREDENTIAL} ` +
        '(LoadCredentialEncrypted= in the unit, deploy/systemd/README.md); it is never read from the environment or the config',
    );
  const path = join(credentialsDirectory, PASSPHRASE_CREDENTIAL);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    throw new RuntimeSetupError(
      `the credential ${PASSPHRASE_CREDENTIAL} could not be read${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  const body = stripNewline(raw);
  if (body.length < MIN_PASSPHRASE_BYTES || body.length > MAX_PASSPHRASE_BYTES) {
    raw.fill(0);
    throw new RuntimeSetupError(
      `the credential ${PASSPHRASE_CREDENTIAL} must hold ${String(MIN_PASSPHRASE_BYTES)} to ${String(MAX_PASSPHRASE_BYTES)} bytes`,
    );
  }
  // A view into `raw`: wiping it wipes the whole read.
  return Buffer.from(body.buffer, body.byteOffset, body.length);
}

async function readKeyFile(keyFile: string): Promise<Uint8Array> {
  await assertPrivate(keyFile, 'the key file');
  const fh = await open(keyFile, 'r').catch((err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    throw new RuntimeSetupError(
      code === 'ENOENT'
        ? `no key file at ${keyFile}: create one with --keygen (deploy/systemd/README.md)`
        : `the key file ${keyFile} could not be opened${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  });
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES)
      throw new RuntimeSetupError(`the key file ${keyFile} is not a key file`);
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Unlock the node's key file. Refuses a file without a wallet key: the daemon must redeem. */
export async function unlockIdentity(o: {
  readonly keyFile: string;
  readonly credentialsDirectory: string | undefined;
}): Promise<NodeIdentity> {
  const file = await readKeyFile(o.keyFile);
  let header: signerMod.KeyFileHeader;
  try {
    header = signerMod.readKeyFileHeader(file);
  } catch (err) {
    throw new RuntimeSetupError(
      `the key file ${o.keyFile} is not readable: ${err instanceof Error ? err.message : 'malformed'}`,
    );
  }
  if (!header.walletKey)
    throw new RuntimeSetupError(
      `the key file ${o.keyFile} carries no wallet key: a seeder must redeem what viewers lock to it — create a new one with --keygen`,
    );
  const pass = await readPassphrase(o.credentialsDirectory);
  let signer: signerMod.LocalSigner;
  try {
    signer = await signerMod.LocalSigner.unlock(file, pass);
  } catch (err) {
    throw new RuntimeSetupError(
      `the key file ${o.keyFile} did not unlock: ${err instanceof Error ? err.message : 'failed'}`,
    );
  } finally {
    pass.fill(0);
  }
  const p2pk = signer.walletP2pk;
  if (p2pk === null) {
    await signer.lock();
    throw new RuntimeSetupError(`the key file ${o.keyFile} carries no wallet key`);
  }
  return { signer, pubkey: await signer.getPublicKey(), p2pk };
}

/**
 * `--keygen`: a new random Nostr key and wallet key, sealed under `passphrase` (the same bytes
 * the credential will hold), written to `keyFile` with mode 0600. Never overwrites a file.
 */
export async function createKeyFile(o: {
  readonly keyFile: string;
  readonly passphrase: Uint8Array;
  readonly cost?: signerMod.KdfCost;
}): Promise<{ readonly pubkey: NostrPubkey }> {
  if (o.passphrase.length < MIN_PASSPHRASE_BYTES || o.passphrase.length > MAX_PASSPHRASE_BYTES)
    throw new RuntimeSetupError(
      `the passphrase must be ${String(MIN_PASSPHRASE_BYTES)} to ${String(MAX_PASSPHRASE_BYTES)} bytes`,
    );
  const walletKey = signerMod.secureAlloc(32);
  let created: Awaited<ReturnType<typeof signerMod.LocalSigner.create>>;
  try {
    // A valid secp256k1 scalar with overwhelming probability; LocalSigner refuses the rest.
    randomFillSync(walletKey);
    created = await signerMod.LocalSigner.create({
      passphrase: o.passphrase,
      walletKey,
      ...(o.cost === undefined ? {} : { cost: o.cost }),
    });
  } finally {
    signerMod.wipe(walletKey);
  }
  const pubkey = await created.signer.getPublicKey();
  await created.signer.lock();
  const fh = await open(o.keyFile, 'wx', 0o600).catch((err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    throw new RuntimeSetupError(
      code === 'EEXIST'
        ? `${o.keyFile} already exists: --keygen never overwrites a key file`
        : `could not create ${o.keyFile}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  });
  try {
    await fh.writeFile(created.file);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { pubkey };
}
