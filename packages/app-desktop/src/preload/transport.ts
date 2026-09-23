/**
 * The preload's side of the renderer ⇄ main hop (design §2): numbered calls over
 * `ipcRenderer.invoke(CHANNEL.call)`, subscriptions over `CHANNEL.sub` with events arriving on
 * `CHANNEL.event`, SE-1 grants over `CHANNEL.grant`. Replies are envelope-checked; failures
 * become `IpcError`s whose message keeps the `"<code>: "` prefix (the only part that survives
 * `contextBridge`).
 *
 * Electron-free: `preload.ts` passes `ipcRenderer`; tests pass a fake that is wired to the IPC
 * gate and a fake host.
 */
import type {
  ArgsOf,
  FileToken,
  Method,
  ResultOf,
  Topic,
  TopicName,
  TopicPayload,
} from '../ipc/protocol.js';
import { CHANNEL, IPC_V, LIMITS } from '../ipc/protocol.js';
import { isEventMsg, isFileToken, isReplyMsg } from '../ipc/guards.js';
import { fromWireError, wireError } from '../ipc/errors.js';

export interface IpcRendererLike {
  invoke(channel: string, msg: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, msg: unknown) => void): unknown;
}

type TopicOf<T extends TopicName> = Extract<Topic, { readonly t: T }>;

export interface Transport {
  call<M extends Method>(method: M, args: ArgsOf<M>): Promise<ResultOf<M>>;
  /** Subscribes at once; `unsubscribe` is idempotent and waits for the ack before `unsub`. */
  subscribe<T extends TopicName>(
    topic: TopicOf<T>,
    cb: (payload: TopicPayload[T]) => void,
  ): () => void;
  /** Resolves once the host has acknowledged the subscription (rejects if it refused). */
  subscribeAcked<T extends TopicName>(
    topic: TopicOf<T>,
    cb: (payload: TopicPayload[T]) => void,
  ): Promise<() => void>;
  grantFile(path: string): Promise<FileToken>;
}

const MAX_ID = 0x7fffffff;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || ArrayBuffer.isView(x))
    return false;
  const p: unknown = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

/**
 * Drops `undefined`-valued keys of plain objects, recursively (arrays keep their slots — a
 * trailing `undefined` argument is legal). The guards treat an optional key as absent-only,
 * while JavaScript callers routinely write `{ cursor: undefined }`.
 */
export function stripUndefined(x: unknown, depth = 0): unknown {
  if (depth > LIMITS.maxDepth) return x;
  if (Array.isArray(x)) return x.map((v) => stripUndefined(v, depth + 1));
  if (!isPlainObject(x)) return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === undefined) continue;
    Object.defineProperty(out, k, {
      value: stripUndefined(v, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function createTransport(ipc: IpcRendererLike): Transport {
  let nextCall = 1;
  let nextSub = 1;
  const handlers = new Map<number, (payload: unknown) => void>();

  ipc.on(CHANNEL.event, (_event, msg) => {
    if (!isEventMsg(msg)) return;
    const h = handlers.get(msg.subId);
    if (h === undefined) return;
    try {
      h(msg.payload);
    } catch {
      // A throwing listener must not break delivery to the others.
    }
  });

  const takeId = (): number => {
    const id = nextCall;
    nextCall = nextCall >= MAX_ID ? 1 : nextCall + 1;
    return id;
  };

  async function send(channel: string, msg: unknown, id: number): Promise<unknown> {
    let reply: unknown;
    try {
      reply = await ipc.invoke(channel, msg);
    } catch {
      throw fromWireError(wireError('backend-down', 'the app backend did not answer'));
    }
    if (!isReplyMsg(reply) || reply.id !== id) {
      throw fromWireError(wireError('internal', 'malformed reply'));
    }
    if (!reply.ok) throw fromWireError(reply.error);
    return reply.result;
  }

  function sub<T extends TopicName>(
    topic: TopicOf<T>,
    cb: (payload: TopicPayload[T]) => void,
  ): { acked: Promise<boolean>; unsubscribe: () => void } {
    const subId = nextSub;
    nextSub = nextSub >= MAX_ID ? 1 : nextSub + 1;
    handlers.set(subId, cb as (payload: unknown) => void);
    const acked = send(CHANNEL.sub, { v: IPC_V, op: 'sub', subId, topic }, subId).then(
      () => true,
      () => {
        handlers.delete(subId);
        return false;
      },
    );
    let done = false;
    const unsubscribe = (): void => {
      if (done) return;
      done = true;
      handlers.delete(subId);
      void acked.then(async (ok) => {
        if (ok)
          await send(CHANNEL.sub, { v: IPC_V, op: 'unsub', subId }, subId).catch(() => undefined);
      });
    };
    return { acked, unsubscribe };
  }

  return {
    async call(method, args) {
      const id = takeId();
      const msg = { v: IPC_V, id, method, args: stripUndefined(args) };
      return (await send(CHANNEL.call, msg, id)) as ResultOf<typeof method>;
    },
    subscribe(topic, cb) {
      return sub(topic, cb).unsubscribe;
    },
    async subscribeAcked(topic, cb) {
      const s = sub(topic, cb);
      if (!(await s.acked)) {
        throw fromWireError(wireError('backend-down', 'could not subscribe to progress'));
      }
      return s.unsubscribe;
    },
    async grantFile(path) {
      const result = await send(CHANNEL.grant, { v: IPC_V, path }, 0);
      if (!isFileToken(result)) throw fromWireError(wireError('internal', 'malformed file token'));
      return result;
    },
  };
}
