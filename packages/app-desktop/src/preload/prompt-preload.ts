/**
 * The prompt window's preload (ADR 0013; bundled to `dist/prompt-preload.cjs`). Exposes ONE key,
 * `window.nutflixPrompt`, with two calls — fetch the question, send the answer — and nothing
 * else: no `ipcRenderer`, no Node, none of the app bridge. Main accepts both only from the open
 * prompt window.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { PROMPT_CHANNEL } from '../ipc/protocol.js';

contextBridge.exposeInMainWorld('nutflixPrompt', {
  question: (): Promise<unknown> => ipcRenderer.invoke(PROMPT_CHANNEL.init),
  answer: (a: unknown): Promise<unknown> => ipcRenderer.invoke(PROMPT_CHANNEL.answer, a),
});
