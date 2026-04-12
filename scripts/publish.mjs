#!/usr/bin/env node
/**
 * Upload packed/*.zip to the .dir marketplace (POST /api/extensions/publish).
 *
 *   pnpm release:dotdir
 *   # or: pnpm build && pnpm zip && DOTDIR_PUBLISH_TOKEN=… pnpm publish:dotdir
 *
 * Optional: DOTDIR_PUBLISH_URL (default https://dotdir.dev/api/extensions/publish)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/** Keep in sync with scripts/pack.mjs */
const PACKAGES = [
  "monaco-editor",
  "image-viewer",
  "file-viewer",
  "csv-viewer",
  "pdf-viewer",
  "font-viewer",
  "sqlite-editor",
  "zip-provider",
  "iso-provider",
  "shell-integration",
  "dsstore-viewer",
  "vscode-languages",
];

const publishUrl =
  process.env.DOTDIR_PUBLISH_URL ?? "https://dotdir.dev/api/extensions/publish";
const token = process.env.DOTDIR_PUBLISH_TOKEN?.trim();

if (!token) {
  console.error("Missing DOTDIR_PUBLISH_TOKEN (publisher access token, Bearer).");
  process.exit(1);
}

async function publishOne(pkgDir) {
  const pkgJsonPath = path.join(rootDir, pkgDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const name = pkg.name || pkgDir;
  const version = pkg.version || "0.0.0";
  const zipName = `${name}-${version}.zip`;
  const zipPath = path.join(rootDir, "packed", zipName);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Missing archive (run pnpm zip): ${zipPath}`);
  }

  const body = fs.readFileSync(zipPath);
  const form = new FormData();
  form.append("archive", new Blob([body]), zipName);

  const res = await fetch(publishUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await res.text();
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error ?? j.message ?? text;
  } catch {
    /* plain text */
  }

  if (!res.ok) {
    throw new Error(`${zipName}: ${res.status} ${detail}`);
  }

  console.log(`ok  ${zipName}`);
}

async function main() {
  console.log(`Publishing to ${publishUrl}\n`);
  for (const pkgDir of PACKAGES) {
    await publishOne(pkgDir);
  }
  console.log("\nAll packages published.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
