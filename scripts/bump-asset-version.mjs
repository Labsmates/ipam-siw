#!/usr/bin/env node
/**
 * bump-asset-version.mjs
 * Ajoute/rafraîchit un paramètre ?v=<hash> sur les <script src="/js/...">
 * de tous les fichiers client/*.html — force le navigateur à recharger le JS
 * après chaque déploiement au lieu de servir une version mise en cache.
 * Appelé automatiquement par le hook post-commit.
 *
 * Usage : node scripts/bump-asset-version.mjs
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const CLIENT_DIR = resolve(ROOT, 'client');

// ── 1. Récupérer le hash du dernier commit ────────────────────────────────────
let hash, subject;
try {
  hash    = execSync('git log -1 --format="%h"', { cwd: ROOT }).toString().trim();
  subject = execSync('git log -1 --format="%s"', { cwd: ROOT }).toString().trim();
} catch (e) {
  console.error('[assets] Impossible de lire le dernier commit :', e.message);
  process.exit(0); // Ne pas bloquer le commit
}

// ── 2. Ignorer les commits de changelog auto (évite la boucle infinie) ────────
// (--force permet une application manuelle ponctuelle, ex. juste après avoir
// ajouté ce script, sans attendre un vrai commit non-changelog)
if (subject.startsWith('chore(changelog):') && !process.argv.includes('--force')) {
  process.exit(0);
}

// ── 3. Parcourir les fichiers HTML et remplacer le paramètre de version ───────
const SRC_RE = /(src="\/js\/[^"?]+\.js)(\?v=[a-f0-9]+)?"/g;

const htmlFiles = readdirSync(CLIENT_DIR).filter(f => f.endsWith('.html'));
let changedCount = 0;

for (const file of htmlFiles) {
  const path = resolve(CLIENT_DIR, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(SRC_RE, (_, base) => `${base}?v=${hash}"`);
  if (after !== before) {
    writeFileSync(path, after, 'utf8');
    changedCount++;
  }
}

console.log(`[assets] Version ${hash} appliquée sur ${changedCount} fichier(s) HTML.`);
