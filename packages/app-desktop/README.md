# @sovit/app-desktop

The Nutflix desktop app, built on Electron. It is split in four so that no process has more power
than it needs:

- `src/main/`: the Electron main process: the window, the `nf-media:` protocol, the IPC gate and
  the native confirmation dialogs for anything that moves money.
- `src/host/`: a Node utility process that holds the Nostr client, the settings, the signer and the
  wallet.
- `src/worker/`: a Bare worker for the peer-to-peer part: Hyperswarm, the Corestore seeder, the
  playback server and the `pay/1` payer.
- `src/preload/` and `src/renderer/`: the sandboxed page and the bridge that exposes the
  `NetworkAdapter` contract to it, and nothing else.

`packaging/` builds the Linux `.deb` and AppImage ([ADR 0017](../../docs/decisions/0017-packaging.md)).
It is internal to this workspace and is not published to npm.

```sh
npm run build                          # at the repository root
npm start -w packages/app-desktop      # an OFFLINE demo: mock wallet, fixture videos
npm run -w packages/app-desktop stage  # stage the packaged app (needs a current build)
```

`npm start` passes `--dev-mocks --dev-fixtures`. A packaged build refuses those flags and uses the
real network. The Chromium sandbox must be able to start; see
[Run from source](../../README.md#run-from-source). The Electron end-to-end suite is
`npm run -w packages/app-desktop test:e2e`.
