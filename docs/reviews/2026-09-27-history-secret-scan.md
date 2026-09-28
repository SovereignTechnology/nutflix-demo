# Full-history secret scan before a public GitHub publish (2026-09-27)

Cameron chose GitHub (`nutflix-demo`, with Actions CI) as the CI route on 2026-09-27; the repo
is private on GitLab since the 2026-09-26 visibility lockdown, and nothing goes public without
this scan and his explicit go-ahead. Read-only; no value was printed at any step.

## Method

- **Positive control first.** A throwaway repo with a freshly generated fake GitHub token
  (`ghp_` + 36 random characters, never real) — gitleaks 8.30.1 reported it (`github-pat`), so
  the scanner and its invocation work. The control repo was deleted.
- **gitleaks** over every ref (`gitleaks git --redact --log-opts=--all`): 335 commits with
  patches (387 in `git rev-list --all`, merges included), about 12 MB.
- **Targeted patterns** gitleaks' rules do not cover, over every added line of `git log --all -p`,
  counted per file only: Nostr `nsec1…`, Cashu `cashuA`/`cashuB` tokens, PEM private keys,
  extended public keys (`xpub`/`ypub`/`zpub`/`tpub`), Lightning invoices, and runs of 12+ BIP-39
  words (classified on-box against the public vectors by equality or hash; never printed).
- **File names ever added** matching `.env`, `.pem`, `.key`, `id_rsa`/`id_ed25519`, `.sealed`,
  `keyfile`, `secret`.

## Results

| Check | Findings | Verdict |
|---|---|---|
| gitleaks `generic-api-key` | 33, in `docs/vendor/` (NUT-00, NUT-03, NUT-13 test vectors, NIP-44, NIP-60), `worker/dev/dleq-selfcheck.ts` (a keyset id and proof secrets of a test mint at a `.invalid` URL: public self-check vectors), `seed.test.ts` (a keyset id), `nip60-journal.ts` (a file name in a comment) and unit tests (19-character fake media tokens, a planted log-hygiene canary) | all false positives — public or synthetic |
| `nsec1…` | 0 | clean |
| Cashu tokens | 4: the NUT-00 spec example, a redaction test's fixture | public / synthetic |
| PEM private keys | 0 | clean |
| extended public keys | 0 | clean |
| Lightning invoices (full length) | 0 | clean |
| 12-word BIP-39 runs | 8: NUT-13 spec vectors, the BIP-39 "legal winner …" vector in a comment, sequential wordlist runs in IPC samples and a bridge test | public / synthetic |
| sensitive file names | `core/src/signer/keyfile.ts` and its test (source code, not key files) | clean |

**No secret, key, wallet material or real mnemonic is in any commit on any ref.** The publish
still needs Cameron's decisions on the GitHub account/org and on which branches and history go
public.
