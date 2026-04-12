#!/usr/bin/env node
/**
 * Upload packed/*.zip to the .dir marketplace (POST /api/extensions/publish).
 *
 *   pnpm release:dotdir
 *   # or: pnpm build && pnpm zip && DOTDIR_PUBLISH_TOKEN=… pnpm publish:dotdir
 *
 * Optional: DOTDIR_PUBLISH_URL (default https://dotdir.dev/api/extensions/publish)
 *
 * HTTP 409 (version already on marketplace) is treated as success so CI can
 * publish a matrix of extensions without failing the whole job when only some
 * package.json versions were bumped.
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
    // API returns 409 when extension_versions already has this semver
    // (see dotdir-website publish route).
    if (res.status === 409) {
      console.log(`skip ${zipName} (${detail})`);
      return "skip";
    }
    throw new Error(`${zipName}: ${res.status} ${detail}`);
  }

  console.log(`ok   ${zipName}`);
  return "ok";
}

async function main() {
  console.log(`Publishing to ${publishUrl}\n`);
  let ok = 0,
    skip = 0;
  for (const pkgDir of PACKAGES) {
    const r = await publishOne(pkgDir);
    if (r === "skip") skip++;
    else ok++;
  }
  console.log(`\nDone: ${ok} published, ${skip} skipped (version already exists).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
