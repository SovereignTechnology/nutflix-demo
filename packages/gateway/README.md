# @sovit/gateway

A seeder plus a WebSocket bridge and a Blossom HTTP server, with an index from sha256 to blob. It
was written so that a client that cannot join the Hyperswarm network itself, such as the web shell
planned in the early designs, could fetch and upload blobs. It is internal to this workspace and is
not part of the desktop release.

- It serves the blobs it holds (uploads and mirrors); it does not yet fetch from upstream seeders
  on its own.
- It listens on `127.0.0.1:8080` by default and never terminates TLS, so put a reverse proxy in
  front of it and set `blossom.publicUrl` to the proxy's origin.
- Its authorisation code (`src/auth/`) is part of the audit surface: nothing there logs and it
  imports only the audited libraries ([SECURITY.md](../../SECURITY.md#locked-directories)).
- It is a network service, so section 13 of the AGPL applies: users who interact with a modified
  version are entitled to its source.

```sh
npm run build
node packages/gateway/dist/index.js --config gateway.json --check   # validate the config and exit
```

The config keys, the key file and passphrase handling, the exit codes and the hardened systemd unit
are documented in [`deploy/systemd/README.md`](../../deploy/systemd/README.md). `--dev-mocks` swaps
in a mock payment engine and accepts every Blossom request: it is for development only and refuses
to listen on anything but loopback.
