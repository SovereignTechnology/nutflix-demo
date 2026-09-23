/**
 * Renderer entry (bundled to `dist/renderer/app.js` by scripts/bundle.ts; loaded by the static
 * `index.html` with `<script type="module" src="app.js">` under a CSP with no inline anything).
 *
 * `window.nutflix` (the preload's bridge) → rehydrating adapter → the ONE playback coordinator
 * wrap → the shell. No network from here: `connect-src 'none'`; everything goes over the bridge.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { adapterFromBridge } from './adapter/rehydrate.js';
import type { NutflixBridge } from './bridge-types.js';
import { Shell } from './App.js';
import { createShellModel } from './model.js';

function boot(root: HTMLElement): void {
  const bridge = (window as unknown as { nutflix?: NutflixBridge }).nutflix;
  if (bridge === undefined) {
    root.textContent = 'Nutflix could not start: the desktop bridge is missing.';
    return;
  }
  const model = createShellModel(adapterFromBridge(bridge));
  createRoot(root).render(
    <StrictMode>
      <Shell
        adapter={model.adapter}
        coordinator={model.coordinator}
        router={model.router}
        probeFfmpeg={(recheck) => bridge.desktop.ffmpeg({ recheck })}
      />
    </StrictMode>,
  );
}

const root = document.getElementById('root');
if (root !== null) boot(root);
