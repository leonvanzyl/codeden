---
section: fixed
---

- **`pnpm desktop:build` works on macOS again.** The host-only build pointed electron-builder at the folder of the Electron executable, which on macOS is `Electron.app/Contents/MacOS` rather than the `dist` folder, so packaging stopped with "corrupted Electron dist". It now uses the electron package's `dist` folder on every platform.
