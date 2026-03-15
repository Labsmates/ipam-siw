#!/bin/bash
# ==============================================================================
# IPAM SIW — Téléchargement des bibliothèques vendor
# À exécuter sur la machine de développement (accès Internet requis)
# avant de déployer sur le serveur cible (sans Internet)
#
# Usage : bash vendor/download-vendor.sh          (skip si déjà présents)
#         bash vendor/download-vendor.sh --force  (forcer le re-téléchargement)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[SKIP]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}   $*"; exit 1; }

FORCE=0
[[ "${1}" == "--force" ]] && FORCE=1

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

info "Bibliothèques vendor dans ${SCRIPT_DIR}/"

# ── Tailwind CSS Play CDN ─────────────────────────────────────────────────────
if [[ -f "${SCRIPT_DIR}/tailwind.min.js" && $FORCE -eq 0 ]]; then
  warn "tailwind.min.js déjà présent ($(du -sh "${SCRIPT_DIR}/tailwind.min.js" | cut -f1)) — ignoré"
else
  info "Téléchargement Tailwind CSS Play CDN…"
  curl -fsSL -o "${SCRIPT_DIR}/tailwind.min.js" https://cdn.tailwindcss.com
  success "tailwind.min.js ($(du -sh "${SCRIPT_DIR}/tailwind.min.js" | cut -f1))"
fi

# ── SheetJS ───────────────────────────────────────────────────────────────────
if [[ -f "${SCRIPT_DIR}/xlsx.full.min.js" && $FORCE -eq 0 ]]; then
  warn "xlsx.full.min.js déjà présent ($(du -sh "${SCRIPT_DIR}/xlsx.full.min.js" | cut -f1)) — ignoré"
else
  info "Téléchargement SheetJS (xlsx)…"
  curl -fsSL -o "${SCRIPT_DIR}/xlsx.full.min.js" \
    https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
  success "xlsx.full.min.js ($(du -sh "${SCRIPT_DIR}/xlsx.full.min.js" | cut -f1))"
fi

# ── Polices Inter + JetBrains Mono (WOFF2 offline) ───────────────────────────
FONTS_DIR="${SCRIPT_DIR}/fonts"
FONTS_CSS="${SCRIPT_DIR}/fonts.css"

if [[ -f "${FONTS_CSS}" && -d "${FONTS_DIR}" && $FORCE -eq 0 ]]; then
  NFONTS=$(ls "${FONTS_DIR}"/*.woff2 2>/dev/null | wc -l | tr -d ' ')
  warn "fonts/ déjà présent (${NFONTS} fichiers WOFF2) — ignoré"
else
  info "Téléchargement polices Inter + JetBrains Mono (Google Fonts → WOFF2)…"
  mkdir -p "${FONTS_DIR}"

  # Nécessite Python 3
  command -v python3 &>/dev/null || error "python3 requis pour télécharger les polices"

  python3 - << PYEOF
import urllib.request, re, os, hashlib

UA = "${UA}"
FONTS_DIR = "${FONTS_DIR}"
FONTS_CSS  = "${FONTS_CSS}"

def fetch_css(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8")

def parse_fontface(css):
    blocks = re.findall(r'@font-face\s*\{([^}]+)\}', css, re.DOTALL)
    faces = []
    for b in blocks:
        family = re.search(r"font-family:\s*'([^']+)'", b)
        style  = re.search(r'font-style:\s*(\w+)', b)
        weight = re.search(r'font-weight:\s*([\d ]+)', b)
        urange = re.search(r'unicode-range:\s*([^;]+);', b)
        src    = re.search(r"url\(([^)]+\.woff2)\)", b)
        if not src: continue
        faces.append({
            "family": family.group(1) if family else "",
            "style":  style.group(1) if style else "normal",
            "weight": weight.group(1).strip() if weight else "400",
            "urange": urange.group(1).strip() if urange else "",
            "url":    src.group(1).strip(),
        })
    return faces

inter_css = fetch_css("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap")
mono_css  = fetch_css("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap")

downloaded = {}

def download_font(url, prefix):
    if url in downloaded:
        return downloaded[url]
    h = hashlib.md5(url.encode()).hexdigest()[:8]
    fname = f"{prefix}-{h}.woff2"
    fpath = os.path.join(FONTS_DIR, fname)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        data = r.read()
    with open(fpath, "wb") as f:
        f.write(data)
    downloaded[url] = fname
    return fname

inter_faces = parse_fontface(inter_css)
mono_faces  = parse_fontface(mono_css)

for face in inter_faces: face["local"] = download_font(face["url"], "inter")
for face in mono_faces:  face["local"] = download_font(face["url"], "jbmono")

lines = ["/* IPAM SIW — Polices locales (offline) */\n"]
for face in inter_faces + mono_faces:
    lines.append(f"""@font-face {{
  font-family: '{face["family"]}';
  font-style: {face["style"]};
  font-weight: {face["weight"]};
  font-display: swap;
  src: url('/vendor/fonts/{face["local"]}') format('woff2');
  unicode-range: {face["urange"]};
}}""")
with open(FONTS_CSS, "w") as f:
    f.write("\n".join(lines))

total = sum(os.path.getsize(os.path.join(FONTS_DIR, f)) for f in os.listdir(FONTS_DIR))
print(f"OK: {len(downloaded)} fichiers WOFF2, {total//1024} KB total")
PYEOF

  success "Polices téléchargées ($(ls "${FONTS_DIR}"/*.woff2 2>/dev/null | wc -l | tr -d ' ') fichiers)"
  success "fonts.css généré"
fi

# ── Résumé ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}vendor/ prêt pour le déploiement${NC}"
echo ""
echo "  JS :"
ls -lh "${SCRIPT_DIR}"/*.js 2>/dev/null | awk '{print "    "$NF" ("$5")"}'
echo "  CSS :"
ls -lh "${SCRIPT_DIR}"/*.css 2>/dev/null | awk '{print "    "$NF" ("$5")"}'
echo "  Fonts ($(ls "${FONTS_DIR}"/*.woff2 2>/dev/null | wc -l | tr -d ' ') fichiers) :"
du -sh "${FONTS_DIR}" 2>/dev/null | awk '{print "    "$2" ("$1")"}'
echo ""
echo "Ces fichiers sont servis par Node.js depuis /vendor/ sur le serveur."
echo ""
