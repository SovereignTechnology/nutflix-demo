/**
 * The shape the preload exposes as `window.nutflix` (design §3 row 2: the NetworkAdapter shape
 * + `desktop.ffmpeg`, nothing else). Wire-typed: Maps are still `WireMap`s and errors carry
 * their code only in the `"<code>: "` message prefix — `contextBridge` copies Errors without
 * custom properties and is not trusted with Maps (risk 5) — so the renderer rebuilds both
 * (`renderer/adapter/rehydrate.ts`).
 *
 * `src/renderer/bridge-types.ts` declares the same shape for the renderer (the two TypeScript
 * projects cannot import each other); both are derived from `src/ipc/protocol.ts` and both
 * sides test their key tree against the same allowlist computed from `METHODS`,
 * `EXCLUDED_METHODS` and `TOPIC_METHODS`.
 */
import type {
  NostrEventId,
  Notification,
  PricePolicy,
  UploadInput,
  VideoManifest,
} from '@sovit/core';
import type {
  ArgsOf,
  Method,
  NfMediaPlayUrl,
  ResultOf,
  TopicPayload,
  UploadProgressWire,
} from '../ipc/protocol.js';

export type Call<M extends Method> = (...args: ArgsOf<M>) => Promise<ResultOf<M>>;
export type Listen<P> = (cb: (payload: P) => void) => () => void;

export interface BridgePlaySession {
  readonly videoId: NostrEventId;
  readonly rendition: string;
  readonly source: { readonly kind: 'url'; readonly url: NfMediaPlayUrl };
  readonly policy: PricePolicy;
  onPeers: Listen<TopicPayload['session.peers']>;
  onSpend: Listen<TopicPayload['session.spend']>;
  setPrefetchSeconds(sec: number): void;
  pause(): void;
  resume(): void;
  switchRendition(label: string): Promise<BridgePlaySession>;
  close(): Promise<void>;
}

/**
 * `studio.upload`'s input as the renderer passes it: the DOM `File` the user picked (never a
 * path — SE-1) and, for a custom thumbnail, the image `Blob`.
 */
export type BridgeUploadInput = Omit<UploadInput, 'file' | 'thumbnailChoice'> & {
  readonly file: File;
  readonly thumbnailChoice?: number | Blob;
};

export interface NutflixBridge {
  readonly platform: 'desktop';
  signer: Call<'signer'>;
  me: Call<'me'>;
  profile: Call<'profile'>;
  feed: Call<'feed'>;
  video: Call<'video'>;
  stats: Call<'stats'>;
  related: Call<'related'>;
  search: Call<'search'>;
  comments: Call<'comments'>;
  comment: Call<'comment'>;
  react: Call<'react'>;
  unreact: Call<'unreact'>;
  nutzap: Call<'nutzap'>;
  subscribe: Call<'subscribe'>;
  unsubscribe: Call<'unsubscribe'>;
  subscriptions: Call<'subscriptions'>;
  report: Call<'report'>;
  readonly library: {
    history: Call<'library.history'>;
    recordProgress: Call<'library.recordProgress'>;
    watchLater: Call<'library.watchLater'>;
    setWatchLater: Call<'library.setWatchLater'>;
    playlists: Call<'library.playlists'>;
    savePlaylist: Call<'library.savePlaylist'>;
    liked: Call<'library.liked'>;
  };
  play(videoId: NostrEventId, rendition?: string): Promise<BridgePlaySession>;
  image: Call<'image'>;
  readonly wallet: {
    mints: Call<'wallet.mints'>;
    balance: Call<'wallet.balance'>;
    balances: Call<'wallet.balances'>;
    mintQuote: Call<'wallet.mintQuote'>;
    pollQuote: Call<'wallet.pollQuote'>;
    meltQuote: Call<'wallet.meltQuote'>;
    melt: Call<'wallet.melt'>;
    history: Call<'wallet.history'>;
    onChange: Listen<TopicPayload['wallet.change']>;
    /** D3/D5: stubs that always reject `forbidden: …`. */
    send(...args: unknown[]): Promise<never>;
    receive(...args: unknown[]): Promise<never>;
    p2pkPubkey(...args: unknown[]): Promise<never>;
    keyset(...args: unknown[]): Promise<never>;
  };
  readonly studio: {
    upload(
      input: BridgeUploadInput,
      onProgress: (p: UploadProgressWire) => void,
    ): Promise<VideoManifest>;
    myVideos: Call<'studio.myVideos'>;
    analytics: Call<'studio.analytics'>;
  };
  readonly seeder: {
    status: Call<'seeder.status'>;
    setEnabled: Call<'seeder.setEnabled'>;
    melt: Call<'seeder.melt'>;
    unban: Call<'seeder.unban'>;
    onStatus: Listen<TopicPayload['seeder.status']>;
  };
  settings: Call<'settings'>;
  updateSettings: Call<'updateSettings'>;
  notifications: Listen<Notification>;
  readonly desktop: {
    ffmpeg: Call<'desktop.ffmpeg'>;
  };
}
