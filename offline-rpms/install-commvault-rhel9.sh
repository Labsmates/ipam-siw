#!/bin/bash
# ==============================================================================
# IPAM SIW — Installation Commvault File System Agent sur RHEL 9 x86_64
# À lancer en root sur le serveur cible (hors ligne)
#
# Usage :
#   scp offline-rpms/commvault-rhel9/unix_pkg.tar.gz root@SERVEUR:/tmp/
#   ssh root@SERVEUR "bash /tmp/install-commvault-rhel9.sh"
#
# Prérequis :
#   - unix_pkg.tar.gz dans /tmp/ (téléchargé depuis votre CommCell)
#   - Le serveur doit pouvoir joindre le CommCell (port TCP 8400, 8403)
# ==============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Ce script doit être lancé en tant que root"

# ── Variables à adapter ───────────────────────────────────────────────────────
COMMCELL_HOST="<votre-commcell>"          # ex: commvault.intra.laposte.fr
COMMCELL_PORT="8400"
CLIENT_NAME="$(hostname -s)"             # nom du client tel qu'enregistré dans CommCell
INSTALL_DIR="/opt/commvault"
PKG="/tmp/unix_pkg.tar.gz"
EXTRACT_DIR="/tmp/commvault_install"

# ── 1. Vérifications ──────────────────────────────────────────────────────────
info "Vérifications préalables…"

[[ ! -f "$PKG" ]] && error "Package introuvable : $PKG — placez unix_pkg.tar.gz dans /tmp/"

# Dépendances système requises par Commvault
dnf install -y libnsl libncurses compat-openssl11 2>/dev/null || \
  warn "Certaines dépendances optionnelles non disponibles — installation continue"

success "Vérifications OK"

# ── 2. Extraction ─────────────────────────────────────────────────────────────
info "Extraction de $PKG dans $EXTRACT_DIR…"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$PKG" -C "$EXTRACT_DIR"
success "Extraction terminée"

# ── 3. Lancement de l'installation silencieuse ────────────────────────────────
info "Installation de l'agent Commvault (mode silencieux)…"

INSTALLER=$(find "$EXTRACT_DIR" -name "silent_install" -o -name "cvpkgadd" 2>/dev/null | head -1)
[[ -z "$INSTALLER" ]] && INSTALLER=$(find "$EXTRACT_DIR" -name "*.sh" | head -1)
[[ -z "$INSTALLER" ]] && error "Installateur introuvable dans le package — structure inattendue"

chmod +x "$INSTALLER"

# Installation silencieuse avec réponses automatiques
# Le fichier de réponses est généré à la volée
RESPONSE_FILE="/tmp/cv_install_response.xml"
cat > "$RESPONSE_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<CVInstallManager_InstallRequest>
  <CommonOptions>
    <CommCellInfo>
      <csName>${COMMCELL_HOST}</csName>
      <csPort>${COMMCELL_PORT}</csPort>
    </CommCellInfo>
    <clientInfo>
      <clientName>${CLIENT_NAME}</clientName>
    </clientInfo>
    <installDirectory>${INSTALL_DIR}</installDirectory>
    <disableFirewallConfig>0</disableFirewallConfig>
  </CommonOptions>
  <packages>
    <packageInfo>
      <id>702</id>  <!-- File System Agent -->
      <name>File System Agent</name>
    </packageInfo>
  </packages>
</CVInstallManager_InstallRequest>
EOF

"$INSTALLER" -responseFile "$RESPONSE_FILE" 2>&1 || {
  warn "Installation silencieuse non supportée — lancement interactif"
  "$INSTALLER"
}

success "Installation Commvault terminée"

# ── 4. Vérification du service ────────────────────────────────────────────────
info "Vérification des services Commvault…"
sleep 5

if systemctl is-active --quiet GxFWD 2>/dev/null || \
   /opt/commvault/Base/cvd status 2>/dev/null | grep -q "running"; then
  success "Agent Commvault actif"
else
  warn "Service Commvault non détecté — vérifier manuellement :"
  warn "  /opt/commvault/Base/cvd status"
  warn "  systemctl status GxFWD"
fi

# ── 5. Firewall ───────────────────────────────────────────────────────────────
info "Ouverture des ports Commvault dans le firewall…"
firewall-cmd --permanent --add-port=8400/tcp  # CommCell communication
firewall-cmd --permanent --add-port=8403/tcp  # Data protection
firewall-cmd --reload
success "Ports 8400/8403 ouverts"

# ── 6. Nettoyage ──────────────────────────────────────────────────────────────
rm -rf "$EXTRACT_DIR" "$RESPONSE_FILE"

echo ""
success "=== Installation Commvault terminée sur $(hostname) ==="
echo ""
echo "  Vérifier l'enregistrement dans la WebConsole CommCell :"
echo "  https://${COMMCELL_HOST}/webconsole → Clients → ${CLIENT_NAME}"
echo ""
echo "  Commandes utiles :"
echo "    /opt/commvault/Base/cvd status     → état du démon"
echo "    /opt/commvault/Base/qlist client   → liste des clients enregistrés"
