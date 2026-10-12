# @sovit/ui

The React design system and the screens (Home, Watch, Search, Shorts, Channel, Library, Studio,
Wallet and Settings). It talks to the rest of the app only through the `NetworkAdapter` contract
in `@sovit/core`, so the same screens run against the real adapter in the desktop app and against
a mock in Storybook. It is internal to this workspace and is not published to npm.

```sh
npm run build                    # at the repository root: TypeScript, then the CSS
npm run -w packages/ui storybook # Storybook on http://localhost:6006, with mock data
```

Every story is rendered in a light and a dark theme. `packages/ui/scripts/screenshots.ts` captures
each one as a PNG.
