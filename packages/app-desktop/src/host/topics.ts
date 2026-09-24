/**
 * Topic subscriptions per webContents (design §2 `Topic`, L6-0 `TOPIC_METHODS`): the
 * callback-shaped parts of the adapter (`seeder.onStatus`, `notifications`, `wallet.onChange`,
 * `PlaySession.onPeers/onSpend`, `studio.upload`'s `onProgress`) become `EventMsg`s for the
 * webContents that subscribed. Capped at `LIMITS.subsPerWc` per webContents; a session topic
 * only binds to a session OF THAT webContents; everything is dropped on `wc-gone`.
 */
import type { EventMsg, HostOut, Topic } from '../ipc/protocol.js';
import { IPC_V, LIMITS } from '../ipc/protocol.js';
import { dehydrate } from '../ipc/wiremap.js';
import type { DesktopNetworkAdapter } from './adapter.js';
import { fail } from './errors.js';
import type { Logger } from './log.js';

interface Sub {
  readonly topic: Topic;
  off: () => void;
}

export class TopicRegistry {
  private readonly adapter: DesktopNetworkAdapter;
  private readonly post: (out: HostOut) => void;
  private readonly log: Logger;
  private readonly byWc = new Map<number, Map<number, Sub>>();

  constructor(adapter: DesktopNetworkAdapter, post: (out: HostOut) => void, log: Logger) {
    this.adapter = adapter;
    this.post = post;
    this.log = log.child('topics');
  }

  /** Live subscriptions of `wc` (tests). */
  count(wc: number): number {
    return this.byWc.get(wc)?.size ?? 0;
  }

  /** Throws a coded error (`invalid-argument`, `rate-limited`, `session-closed`) on refusal. */
  sub(wc: number, subId: number, topic: Topic): void {
    let subs = this.byWc.get(wc);
    if (subs?.has(subId)) fail('invalid-argument', 'subscription id already in use');
    if ((subs?.size ?? 0) >= LIMITS.subsPerWc) fail('rate-limited', 'too many subscriptions');
    const emit = (payload: unknown): void => {
      let clean: unknown;
      try {
        clean = dehydrate(payload);
      } catch {
        this.log.warn('dropped an event payload that cannot cross IPC', { topic: topic.t });
        return;
      }
      const msg: EventMsg = { v: IPC_V, subId, payload: clean };
      this.post({ kind: 'event', wc, msg });
    };
    const sub: Sub = { topic, off: () => undefined };
    const a = this.adapter;
    switch (topic.t) {
      case 'seeder.status':
        sub.off = a.seeder.onStatus(emit);
        break;
      case 'notifications':
        sub.off = a.notifications(emit);
        break;
      case 'wallet.change':
        sub.off = a.wallet.onChange(emit);
        break;
      case 'session.peers':
      case 'session.spend': {
        const s = a.sessions.get(wc, topic.sid);
        if (s === undefined) fail('session-closed', 'no such playback session');
        sub.off = topic.t === 'session.peers' ? s.onPeers(emit) : s.onSpend(emit);
        s.onClose(() => {
          this.drop(wc, subId, sub);
        });
        break;
      }
      case 'upload.progress':
        sub.off = a.onUploadProgress(wc, topic.uploadId, emit);
        break;
      case 'signer.status':
        sub.off = a.onSignerStatus(emit);
        break;
    }
    if (subs === undefined) {
      subs = new Map();
      this.byWc.set(wc, subs);
    }
    subs.set(subId, sub);
  }

  /** Idempotent. */
  unsub(wc: number, subId: number): void {
    const sub = this.byWc.get(wc)?.get(subId);
    if (sub !== undefined) this.drop(wc, subId, sub);
  }

  /** `wc-gone`. */
  dropWc(wc: number): void {
    const subs = this.byWc.get(wc);
    if (subs === undefined) return;
    this.byWc.delete(wc);
    for (const sub of subs.values()) this.off(sub);
  }

  private drop(wc: number, subId: number, sub: Sub): void {
    const subs = this.byWc.get(wc);
    if (subs?.get(subId) !== sub) return;
    subs.delete(subId);
    if (subs.size === 0) this.byWc.delete(wc);
    this.off(sub);
  }

  private off(sub: Sub): void {
    try {
      sub.off();
    } catch {
      this.log.warn('unsubscribe threw');
    }
  }
}
