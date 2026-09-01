#!/usr/bin/env node
/**
 * bump-version.mjs
 * Incrémente le patch de version (package.json) à chaque commit et
 * répercute le nouveau numéro dans client/index.html (footer login)
 * et client/js/api.js (constante APP_VERSION — badge sidebar).
 * Appelé automatiquement par le hook post-commit.
 *
 * Usage : node scripts/bump-version.mjs
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const PKG_PATH    = resolve(ROOT, 'package.json');
const INDEX_PATH  = resolve(ROOT, 'client', 'index.html');
const API_JS_PATH = resolve(ROOT, 'client', 'js', 'api.js');

// ── 1. Ignorer les commits de changelog auto (évite la boucle infinie) ────────
let subject;
try {
  subject = execSync('git log -1 --format="%s"', { cwd: ROOT }).toString().trim();
} catch (e) {
  console.error('[version] Impossible de lire le dernier commit :', e.message);
  process.exit(0);
}
if (subject.startsWith('chore(changelog):')) process.exit(0);

// ── 2. Incrémenter le patch dans package.json ─────────────────────────────────
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const parts = pkg.version.split('.').map(Number);
parts[2] = (parts[2] || 0) + 1;
const newVersion = parts.join('.');
pkg.version = newVersion;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// ── 3. Répercuter dans index.html (footer page de connexion) ─────────────────
let index = readFileSync(INDEX_PATH, 'utf8');
index = index.replace(/IPAM SIW v\d+\.\d+\.\d+/, `IPAM SIW v${newVersion}`);
writeFileSync(INDEX_PATH, index, 'utf8');

// ── 4. Répercuter dans api.js (badge version sidebar) ─────────────────────────
let apiJs = readFileSync(API_JS_PATH, 'utf8');
apiJs = apiJs.replace(/export const APP_VERSION = '[\d.]+';/, `export const APP_VERSION = '${newVersion}';`);
writeFileSync(API_JS_PATH, apiJs, 'utf8');

console.log(`[version] ${pkg.version} appliquée (index.html, api.js).`);
