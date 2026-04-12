# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A monorepo of built-in extensions for the .dir file manager (a Tauri app). Each extension is a self-contained IIFE bundle that runs in an iframe, communicating with the host app via a standardized API. The sibling repo `dotdir` bundles this folder as a resource.

## Commands

```bash
pnpm install                          # Install dependencies
pnpm build                            # Build all extensions
pnpm --filter monaco-editor run build # Build a single extension
pnpm dev                              # Watch mode for all extensions
pnpm zip                              # Create zip archives in packed/ (not `pnpm pack` — that is pnpm’s tarball)
pnpm publish:dotdir                   # Upload packed/*.zip (needs DOTDIR_PUBLISH_TOKEN); 409 = already published, skipped
pnpm release:dotdir                   # build + zip + publish:dotdir
```

## GitHub Actions

Workflow [`.github/workflows/publish-dotdir-marketplace.yml`](.github/workflows/publish-dotdir-marketplace.yml) runs **manually** (`Actions` → *Publish extensions to dotdir.dev* → *Run workflow*). Add repository secret **`DOTDIR_PUBLISH_TOKEN`** (publisher access token from the dotdir.dev extensions dashboard). Bump `version` in each extension’s `package.json` before publishing so the marketplace accepts the upload.

There are no tests or linting configured.

## Architecture

### Extension API Contract

The extension API object must implement:
- `mount(root: HTMLElement, props: ViewerProps | EditorProps): Promise<void>`
- `unmount(): Promise<void>`

The host provides `dotdir` global variable with methods like `readFile()`, `readFileText()`, `readFileRange()`, `getTheme()`, and `onClose()`.

### Extension Structure

Each extension follows the same layout:
- `src/entry.ts` — Factory that creates the API object and registers with host
- `src/types.ts` — TypeScript interfaces for host/extension communication
- `src/viewer.ts` or `src/editor.ts` — Core implementation
- `vite.config.ts` — Builds to `dist/viewer.iife.js` or `dist/editor.iife.js`

### Extension Registration via package.json

Extensions declare what they handle in `contributes`:
```json
"contributes": {
  "viewers": [{ "id": "csv-viewer", "patterns": ["*.csv"], "entry": "dist/viewer.iife.js", "priority": 10 }]
}
```
Editors use `"editors"` and may also declare `"languages"` and `"grammars"`.

### Build

All extensions use Vite with IIFE output format (required for blob: URL execution in iframes). Each produces a single self-contained JS bundle with no shared dependencies between extensions. Monaco editor is the exception — it's significantly larger (~893KB) because it inlines the Monaco library and workers.

### Packaging

`scripts/pack.mjs` zips each extension's `package.json` + `dist/` into `packed/{name}-{version}.zip`, skipping private packages or those without `contributes`.

## Current Extensions

- **monaco-editor** — Code editor with TextMate grammar highlighting, multi-language support
- **image-viewer** — Images and video (PNG, JPG, GIF, SVG, MP4, WebM, etc.)
- **file-viewer** — Generic fallback with virtual scrolling for large files (chunked 64KB reads)
- **csv-viewer** — RFC 4180 CSV parser with HTML table rendering
- **pdf-viewer** — Browser-native PDF embed
