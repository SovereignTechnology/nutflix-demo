/**
 * `@sovit/app-desktop` host (lane L6-B): the `utilityProcess` that owns the real
 * `NetworkAdapter`. `./main.ts` is the process entry; everything here is importable under plain
 * Node (tests, and L6-A's fallback of running the host module inside main — design risk 5).
 */
export { DesktopNetworkAdapter } from './adapter.js';
export type { DesktopAdapterOptions } from './adapter.js';
export { Host, createHost } from './host.js';
export type { HostOptions } from './host.js';
export { runHost } from './main.js';
export type { ParentPortLike, RunOptions } from './main.js';
export { parseHostArgs, HostArgsError } from './flags.js';
export type { HostArgs, HostFlags } from './flags.js';
export { NoIdentity, DevViewerIdentity, SignerIdentity } from './identity.js';
export type { IdentityProvider } from './identity.js';
export { createLogger, memoryLogger, redact, silentLogger } from './log.js';
export type { Logger, LogLevel, LogSink } from './log.js';
export { WorkerSupervisor, DEFAULT_RESTART } from './worker/supervisor.js';
export type {
  RestartPolicy,
  SpawnWorker,
  Timers,
  WorkerProcess,
  WorkerState,
} from './worker/supervisor.js';
export { ImageService, sniffImage, MAX_IMAGE_BYTES, MAX_REDIRECTS } from './images/images.js';
export { checkImageUrl, httpsTransport, isNonPublicAddress, safeLookup } from './images/net.js';
export type { ImageTransport, ImageResponse } from './images/net.js';
export {
  DEFAULT_SETTINGS,
  SettingsStore,
  autoTopUpDue,
  loadDesktopConfig,
  parseStoredSettings,
} from './settings/settings.js';
export { buildUnreactDeletion, DELETION_KIND } from './social/reactions.js';
export { FixtureCatalog } from './catalog/fixture-catalog.js';
export { NostrCatalog } from './catalog/catalog.js';
export type { CatalogSource } from './catalog/catalog.js';
export { UnavailableWallet, createWalletProvider } from './wallet.js';
