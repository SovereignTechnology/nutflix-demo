/**
 * The desktop wallet journal on disk (ADR 0014 amendment, issue #8): one sealed file per identity,
 * `<userData>/wallet/journal-<pubkey>.sealed`, 0600 in a 0700 directory — the signer key file's
 * rules (`signer/private-file.ts`): a symlink, a non-regular file, a file another user owns or can
 * read is refused, never used; every write goes to a fresh exclusive temp file, is fsynced and
 * renamed over the old one, then the directory is fsynced. So a journal write that resolved is on
 * disk, and a crash mid-write leaves the previous journal whole.
 *
 * What is in it and how it is sealed is core's (`wallet/nip60-journal.ts`: a random key wrapped
 * with NIP-44 to self, XChaCha20-Poly1305). Per identity because it is sealed to one: another
 * identity's journal is not "unreadable", it is simply not ours to open.
 *
 * Writes to one path are serialised across wallet instances, and an open waits for the previous
 * instance's last write: a signer swap closes the old money plane while one of its operations may
 * still be writing, and the new one must read what that write left.
 *
 * Nothing here logs; errors carry no path (it names the user's pubkey).
 */
import { join } from 'node:path';

import type { NostrPubkey, Signer } from '@sovit/core';
import { wallet as walletMod } from '@sovit/core';

import { ensurePrivateDir, readPrivateFile, writePrivateFile } from './signer/private-file.js';

/** `<userData>/<this>`: the wallet journal's directory. */
export const WALLET_DIR = 'wallet';

const HEX64 = /^[0-9a-f]{64}$/;

/** The journal file of `pubkey` in `dir`. */
export function journalPath(dir: string, pubkey: NostrPubkey): string {
  if (!HEX64.test(pubkey)) throw new Error('invalid-argument: not a pubkey');
  return join(dir, `journal-${pubkey}.sealed`);
}

/** The last write started on each journal path (any instance). */
const writing = new Map<string, Promise<void>>();

/** Resolves once every write already started on `path` has finished (failed ones included). */
function settled(path: string): Promise<void> {
  return (writing.get(path) ?? Promise.resolve()).catch(() => undefined);
}

/** `JournalFile` over a private file. */
export function journalFile(path: string): walletMod.JournalFile {
  return {
    read: async () => {
      await settled(path);
      let bytes: Uint8Array | null;
      try {
        bytes = await readPrivateFile(path, walletMod.MAX_JOURNAL_BYTES);
      } catch {
        // A symlink, another user's file, one others can read, one too large: refused like a
        // damaged journal — loudly, and left where it is (the reason names no path).
        throw new walletMod.JournalError(
          'the journal file is refused: it must be a regular 0600 file of this user, at most 32 MiB',
        );
      }
      if (bytes === null) return null;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new walletMod.JournalError('the journal file is not UTF-8');
      }
    },
    write: (text) => {
      const run = settled(path).then(() => writePrivateFile(path, new TextEncoder().encode(text)));
      writing.set(path, run);
      void run
        .catch(() => undefined)
        .then(() => {
          if (writing.get(path) === run) writing.delete(path);
        });
      return run;
    },
  };
}

/**
 * Open (or start) the journal of the signer's identity in `dir` (created 0700). Throws
 * `journal-unreadable: …` for a file that exists but does not open — the file is left as it is.
 */
export async function openWalletJournal(o: {
  readonly dir: string;
  readonly signer: Pick<Signer, 'nip44Encrypt' | 'nip44Decrypt'>;
  readonly pubkey: NostrPubkey;
}): Promise<walletMod.SealedJournal> {
  await ensurePrivateDir(o.dir, 'the wallet directory');
  return walletMod.SealedJournal.open({
    file: journalFile(journalPath(o.dir, o.pubkey)),
    signer: o.signer,
    pubkey: o.pubkey,
  });
}
