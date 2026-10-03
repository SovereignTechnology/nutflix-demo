**Nutflix desktop for Linux (x86_64).** A peer-to-peer video player that pays seeders in Cashu ecash.

| File                         | For                                                         |
| ---------------------------- | ----------------------------------------------------------- |
| `nutflix_<version>_amd64.deb` | Debian and Ubuntu, including Ubuntu 24.04 and later (recommended) |
| `Nutflix-<version>-x64.AppImage` | Other distributions. **Not for Ubuntu 24.04 or later**: it cannot start there without a user-namespace grant, so use the `.deb` |

## Verify before you install

These files are **not signed by an operating-system vendor**: your system may warn about that. Their integrity rests on two things published with this release:

- `SHA256SUMS`: check a download with `sha256sum -c SHA256SUMS --ignore-missing`.
- A Nostr release notice (kind 30071, `d` = `nutflix-desktop`) signed by the SovTech key `npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx`, on `wss://relay.damus.io`, `wss://nos.lol` and `wss://relay.primal.net`. With a checkout of this repository and the signed event saved as `release-event.json`:

  ```sh
  node scripts/release-verify.mjs release-event.json --all <download-dir>
  ```

  It checks the signature, that the key is SovTech's, and every file's size and sha256. An older genuine release also verifies, so compare its version and date with the current notice on the relays.

`release-event.unsigned.json` is the notice before signing, attached for reference: it is not proof of anything until the signed notice is on the relays.
