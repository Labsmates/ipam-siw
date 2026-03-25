#!/bin/bash
# ==============================================================================
# IPAM SIW — Prérequis page Configuration système (super admin)
#
# À exécuter en tant que root, après le déploiement initial.
# Requis pour que l'utilisateur 'ipam' puisse :
#   - contrôler les services via systemctl (restart/reload/status)
#   - lire les journaux via journalctl
#   - lire/écrire le fichier RDB Redis (sauvegarde / restauration)
#
# Utilisation :
#   bash deploy/setup-config-permissions.sh
# ==============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Ce script doit être lancé en tant que root"

SERVICE_USER="ipam"
SUDOERS_FILE="/etc/sudoers.d/ipam"
RDB_PATH="/var/lib/redis/ipam.rdb"

# ── Vérifier que l'utilisateur ipam existe ─────────────────────────────────
if ! id -u "${SERVICE_USER}" &>/dev/null; then
  error "L'utilisateur '${SERVICE_USER}' n'existe pas. Lancez d'abord deploy/deploy.sh"
fi

# ── 1. Fichier sudoers ─────────────────────────────────────────────────────
info "1/3 — Configuration sudo pour '${SERVICE_USER}'…"

cat > "${SUDOERS_FILE}" <<'EOF'
# IPAM SIW — Droits sudo pour la page Configuration système
# Permet à l'user 'ipam' (service Node.js) de gérer les services
# et lire les journaux sans mot de passe.

# Statut des services
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status httpd
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status redis

# Démarrage
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl start ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl start httpd
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl start redis

# Arrêt
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl stop ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl stop httpd
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl stop redis

# Redémarrage / rechargement
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl restart ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl restart redis
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl reload httpd

# Redémarrage / arrêt du serveur (sans restriction d'arguments — délai et message variables)
ipam ALL=(root) NOPASSWD: /usr/sbin/shutdown

# Journaux
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u ipam -n 100 --no-pager
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u httpd -n 100 --no-pager
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u redis -n 100 --no-pager

# Certificat SSL — création des répertoires si absents
ipam ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/pki/tls/certs
ipam ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/pki/tls/private

# Certificat SSL — copie et permissions
ipam ALL=(root) NOPASSWD: /usr/bin/cp /var/www/ipam/data/ipam_cert.pem /etc/pki/tls/certs/ipam.crt
ipam ALL=(root) NOPASSWD: /usr/bin/cp /var/www/ipam/data/ipam_key.pem /etc/pki/tls/private/ipam.key
ipam ALL=(root) NOPASSWD: /usr/bin/chmod 644 /etc/pki/tls/certs/ipam.crt
ipam ALL=(root) NOPASSWD: /usr/bin/chmod 600 /etc/pki/tls/private/ipam.key
EOF

chmod 440 "${SUDOERS_FILE}"

# Valider la syntaxe sudoers (visudo -c)
if visudo -c -f "${SUDOERS_FILE}" &>/dev/null; then
  success "Fichier sudoers créé : ${SUDOERS_FILE}"
else
  rm -f "${SUDOERS_FILE}"
  error "Syntaxe sudoers invalide — fichier supprimé"
fi

# ── 2. Groupe redis → accès au fichier RDB ─────────────────────────────────
info "2/3 — Ajout de '${SERVICE_USER}' au groupe 'redis'…"

if getent group redis &>/dev/null; then
  usermod -aG redis "${SERVICE_USER}"
  success "Utilisateur '${SERVICE_USER}' ajouté au groupe 'redis'"
else
  warn "Groupe 'redis' introuvable — Redis est-il installé ?"
fi

# ── 3. Permissions sur le fichier RDB ─────────────────────────────────────
info "3/3 — Permissions sur ${RDB_PATH}…"

if [[ -f "${RDB_PATH}" ]]; then
  chown redis:redis "${RDB_PATH}"
  chmod 664 "${RDB_PATH}"
  success "Permissions RDB : redis:redis 664"
else
  # Créer un fichier vide avec les bonnes permissions (Redis le remplira)
  mkdir -p "$(dirname "${RDB_PATH}")"
  touch "${RDB_PATH}"
  chown redis:redis "${RDB_PATH}"
  chmod 664 "${RDB_PATH}"
  success "Fichier RDB créé avec permissions : redis:redis 664"
fi

# ── Résumé ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Prérequis Configuration système configurés !${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo ""
echo    "  Sudo    : /etc/sudoers.d/ipam (chmod 440)"
echo    "  Groupe  : ipam ∈ redis"
echo    "  RDB     : ${RDB_PATH} (redis:redis 664)"
echo ""
echo -e "${YELLOW}  Redémarrez le service ipam pour que le changement de groupe prenne effet :${NC}"
echo    "  systemctl restart ipam"
echo ""
