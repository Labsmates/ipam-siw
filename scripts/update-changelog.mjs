#!/usr/bin/env node
/**
 * update-changelog.mjs
 * Injecte le dernier commit git dans le marqueur <!-- CHANGELOG_INSERT -->
 * de client/config.html.
 * Appelé automatiquement par le hook post-commit.
 *
 * Usage : node scripts/update-changelog.mjs
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const HTML_PATH = resolve(ROOT, 'client', 'config.html');
const MARKER    = '<!-- CHANGELOG_INSERT -->';

// ── 1. Récupérer les infos du dernier commit ──────────────────────────────────
let hash, subject, date;
try {
  hash    = execSync('git log -1 --format="%h"',              { cwd: ROOT }).toString().trim();
  subject = execSync('git log -1 --format="%s"',              { cwd: ROOT }).toString().trim();
  date    = execSync('git log -1 --format="%ad" --date=short', { cwd: ROOT }).toString().trim();
} catch (e) {
  console.error('[changelog] Impossible de lire le dernier commit :', e.message);
  process.exit(0); // Ne pas bloquer le commit
}

// ── 2. Ignorer les commits de changelog auto (évite la boucle infinie) ────────
if (subject.startsWith('chore(changelog):')) {
  process.exit(0);
}

// ── 3. Construire la ligne HTML ───────────────────────────────────────────────
const escapeHtml = s => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const line = `              <li><code style="font-size:11px;color:var(--tx-3)">${hash}</code> ${escapeHtml(subject)} <span style="color:var(--tx-3);font-size:11px">(${date})</span></li>`;

// ── 4. Injecter dans config.html ──────────────────────────────────────────────
let html = readFileSync(HTML_PATH, 'utf8');

if (!html.includes(MARKER)) {
  console.error('[changelog] Marqueur CHANGELOG_INSERT introuvable dans config.html');
  process.exit(0);
}

// Vérifie que ce commit n'est pas déjà présent (idempotence)
if (html.includes(`>${hash}<`)) {
  process.exit(0);
}

html = html.replace(MARKER, `${MARKER}\n${line}`);
writeFileSync(HTML_PATH, html, 'utf8');

console.log(`[changelog] Commit ${hash} ajouté au changelog.`);
