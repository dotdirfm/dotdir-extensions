#!/usr/bin/env node
/**
 * Pack extensions into zip archives for marketplace upload.
 * Contents are at the root of the archive (no "package" folder).
 * Includes package.json and everything listed in package.json "files".
 */

import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const PACKAGES = ['monaco-editor', 'image-viewer', 'file-viewer', 'csv-viewer', 'pdf-viewer', 'font-viewer', 'sqlite-editor', 'zip-provider', 'iso-provider'];
const OUT_DIR = path.join(rootDir, 'packed');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function addToArchive(archive, basePath, fileOrDir, archivePath) {
  const full = path.join(basePath, fileOrDir);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    archive.directory(full, archivePath || fileOrDir);
  } else {
    archive.file(full, { name: archivePath || fileOrDir });
  }
}

async function packOne(pkgDir) {
  const pkgPath = path.join(rootDir, pkgDir);
  const pkgJsonPath = path.join(pkgPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  if (pkg.private || (!pkg.contributes && !pkg.files)) return;

  const name = pkg.name || pkgDir;
  const version = pkg.version || '0.0.0';
  const files = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ['dist'];
  const zipName = `${name}-${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    archive.file(pkgJsonPath, { name: 'package.json' });
    for (const f of files) {
      addToArchive(archive, pkgPath, f, f);
    }
    archive.finalize();
  });

  console.log(`  ${zipName}`);
}

async function main() {
  ensureDir(OUT_DIR);
  console.log('Packing extensions to packed/\n');
  for (const pkgDir of PACKAGES) {
    await packOne(pkgDir);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
