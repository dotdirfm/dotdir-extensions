# Faraday extensions

Built-in and third-party extensions for the Faraday file manager. The main app (faraday-tauri) bundles the contents of this folder as the `extensions` resource.

## Built-in extensions

### faraday-monaco-editor

Monaco-based code editor with syntax highlighting. Contributes an editor for all file types (`*.*`) and language metadata for detection.

**Build:** From the `extensions` folder run `pnpm install && pnpm build`, or from the extension folder:

```bash
cd faraday-monaco-editor
pnpm install
pnpm build
```

Output: `dist/editor.iife.js` (and `dist/editor.css`). The host loads `dist/editor.iife.js` as the extension entry.

**Development:** Run `pnpm dev` for watch mode when iterating on the extension.

## Adding the extension to the app bundle

When building the Tauri app, ensure this folder is built first so each extension has its `dist/` (or equivalent) output. The app’s `tauri.conf.json` maps `../extensions` → `extensions`, so the repo layout should be:

- `faraday-fm/extensions/faraday-monaco-editor/` (this repo)
- `faraday-fm/faraday-tauri/` (main app)

Build order: build extensions, then run `pnpm tauri build` (or `pnpm build` then `tauri build`) from faraday-tauri.
