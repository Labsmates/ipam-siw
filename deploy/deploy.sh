#!/bin/bash
# ==============================================================================
# IPAM SIW v2 — Script de déploiement pour Rocky Linux 10
# Serveur : 218.16.185.50
# Backend : Node.js + Redis (SQLite supprimé)
#
# Lancer en tant que root : bash deploy/deploy.sh
#
# Prérequis (machine dev, avant transfert) :
#   bash vendor/download-vendor.sh    # Tailwind + SheetJS
#   npm install                        # node_modules/ (dont ioredis)
# ==============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Ce script doit être lancé en tant que root"
info "Déploiement IPAM SIW v2 sur Rocky Linux 10"

APP_DIR="/var/www/ipam"
DATA_DIR="${APP_DIR}/data"
SERVICE_USER="ipam"
SERVER_IP="218.16.185.50"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "${SCRIPT_DIR}")"

# ── 1. Mise à jour système ────────────────────────────────────────────────────
info "1/11 — Mise à jour du système…"
dnf update -y -q
success "Système à jour"

# ── 2. Dépendances système ────────────────────────────────────────────────────
info "2/11 — Installation Node.js, Apache, mod_ssl, Redis…"

# Node.js depuis les RPMs hors-ligne (si présents)
if ls "${SRC_DIR}/offline-rpms/"*.rpm &>/dev/null; then
  dnf install -y "${SRC_DIR}/offline-rpms/"*.rpm 2>/dev/null || true
fi

# Apache + mod_ssl
dnf install -y httpd mod_ssl

# Redis (depuis les dépôts système Rocky 10 ou RPMs locaux)
if [[ -f "${SRC_DIR}/offline-rpms/redis"*.rpm ]]; then
  dnf install -y "${SRC_DIR}/offline-rpms/redis"*.rpm
else
  dnf install -y redis || warn "Redis non trouvé dans les dépôts — ajoutez redis*.rpm dans offline-rpms/"
fi

# Build tools (pour ioredis natif si nécessaire)
dnf install -y python3 gcc gcc-c++ make 2>/dev/null || true

success "Node.js $(node --version 2>/dev/null || echo '?') | Apache | Redis"

# ── 3. Utilisateur système ────────────────────────────────────────────────────
info "3/11 — Utilisateur système 'ipam'…"
if ! id -u ${SERVICE_USER} &>/dev/null; then
  useradd -r -s /sbin/nologin -d "${APP_DIR}" ${SERVICE_USER}
  success "Utilisateur '${SERVICE_USER}' créé"
else
  warn "L'utilisateur '${SERVICE_USER}' existe déjà"
fi

# ── 4. Copie des fichiers ─────────────────────────────────────────────────────
info "4/11 — Copie des fichiers dans ${APP_DIR}…"
mkdir -p "${APP_DIR}" "${DATA_DIR}"

cp -r "${SRC_DIR}/server"      "${APP_DIR}/"
cp -r "${SRC_DIR}/client"      "${APP_DIR}/"
cp    "${SRC_DIR}/package.json" "${APP_DIR}/"

# vendor/ (bibliothèques JS offline)
if [[ -d "${SRC_DIR}/vendor" ]]; then
  cp -r "${SRC_DIR}/vendor" "${APP_DIR}/"
  success "Bibliothèques vendor copiées"
else
  error "Le dossier vendor/ est absent. Exécutez d'abord : bash vendor/download-vendor.sh"
fi

# ── 5. Dépendances npm ────────────────────────────────────────────────────────
info "5/11 — Modules npm (ioredis, express, jsonwebtoken, cors)…"
cd "${APP_DIR}"
if [[ -d node_modules ]]; then
  warn "node_modules existant conservé"
else
  if [[ -d "${SRC_DIR}/node_modules" ]]; then
    cp -r "${SRC_DIR}/node_modules" "${APP_DIR}/"
    success "node_modules copié depuis les sources"
  else
    npm install --prefer-offline 2>/dev/null || npm install || \
      error "npm install échoué. Copiez node_modules depuis la machine dev."
  fi
fi
success "Modules npm prêts"

# ── 6. Permissions ────────────────────────────────────────────────────────────
info "6/11 — Permissions…"
chown -R root:${SERVICE_USER} "${APP_DIR}"
chown -R ${SERVICE_USER}:${SERVICE_USER} "${DATA_DIR}"
chmod 750  "${APP_DIR}"
chmod 770  "${DATA_DIR}"
find "${APP_DIR}/server" "${APP_DIR}/client" -type f -exec chmod 640 {} \;
find "${APP_DIR}/vendor" -type f -exec chmod 644 {} \; 2>/dev/null || true
usermod -aG ${SERVICE_USER} apache 2>/dev/null || true
success "Permissions configurées"

# ── 6b. Sudo + droits RDB (page Configuration système) ───────────────────────
info "6b — Droits sudo et accès RDB pour la page Configuration…"

SUDOERS_FILE="/etc/sudoers.d/ipam"
cat > "${SUDOERS_FILE}" <<'SUDOERS_EOF'
# IPAM SIW — Droits sudo pour la page Configuration système
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status httpd
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl status redis
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl restart ipam
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl restart redis
ipam ALL=(root) NOPASSWD: /usr/bin/systemctl reload httpd
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u ipam -n 100 --no-pager
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u httpd -n 100 --no-pager
ipam ALL=(root) NOPASSWD: /usr/bin/journalctl -u redis -n 100 --no-pager
SUDOERS_EOF
chmod 440 "${SUDOERS_FILE}"
visudo -c -f "${SUDOERS_FILE}" &>/dev/null && success "Fichier sudoers créé" || \
  { rm -f "${SUDOERS_FILE}"; warn "Syntaxe sudoers invalide — ignoré"; }

getent group redis &>/dev/null && usermod -aG redis "${SERVICE_USER}" && \
  success "Utilisateur '${SERVICE_USER}' ajouté au groupe 'redis'"

RDB_PATH="/var/lib/redis/ipam.rdb"
mkdir -p "$(dirname "${RDB_PATH}")"
[[ ! -f "${RDB_PATH}" ]] && touch "${RDB_PATH}"
chown redis:redis "${RDB_PATH}" && chmod 664 "${RDB_PATH}"
success "Permissions RDB : redis:redis 664"

# ── 7. Redis ──────────────────────────────────────────────────────────────────
info "7/11 — Configuration Redis…"
mkdir -p /etc/redis /var/log/redis /var/lib/redis
cp "${SCRIPT_DIR}/redis.conf" /etc/redis/redis.conf
chown redis:redis /var/log/redis /var/lib/redis 2>/dev/null || true
systemctl enable redis
systemctl restart redis
sleep 1
if systemctl is-active --quiet redis; then
  success "Redis démarré (127.0.0.1:6379)"
else
  error "Redis n'a pas démarré. Vérifiez : journalctl -u redis -n 30"
fi

# ── 8. Certificat SSL ─────────────────────────────────────────────────────────
info "8/11 — Certificat SSL…"
CERT_FILE="/etc/pki/tls/certs/ipam.crt"
KEY_FILE="/etc/pki/tls/private/ipam.key"
if [[ ! -f "${CERT_FILE}" ]]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
    -subj   "/C=FR/ST=France/L=Paris/O=SIW/OU=IT/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" 2>/dev/null
  chmod 600 "${KEY_FILE}"; chmod 644 "${CERT_FILE}"
  success "Certificat SSL auto-signé créé (10 ans)"
  warn "Remplacez par un certificat signé par une CA en production !"
else
  warn "Certificat SSL existant conservé"
fi

# ── 9. Apache ─────────────────────────────────────────────────────────────────
info "9/11 — Configuration Apache…"
cp "${SCRIPT_DIR}/ipam.conf" /etc/httpd/conf.d/ipam.conf
[[ -f /etc/httpd/conf.d/welcome.conf ]] && \
  mv /etc/httpd/conf.d/welcome.conf /etc/httpd/conf.d/welcome.conf.disabled 2>/dev/null || true
grep -q "ServerTokens Prod" /etc/httpd/conf/httpd.conf || \
  echo -e "\nServerTokens Prod\nServerSignature Off" >> /etc/httpd/conf/httpd.conf
httpd -t && success "Config Apache valide" || error "Erreur de syntaxe Apache"

# ── 10. Service Node.js ───────────────────────────────────────────────────────
info "10/11 — Service systemd ipam…"
cp "${SCRIPT_DIR}/ipam.service" /etc/systemd/system/ipam.service
systemctl daemon-reload
systemctl enable ipam
systemctl restart ipam
sleep 2
if systemctl is-active --quiet ipam; then
  success "Service ipam démarré (port 3000)"
else
  error "Le service n'a pas démarré. Vérifiez : journalctl -u ipam -n 50"
fi

# ── 11. Pare-feu + SELinux + Apache ──────────────────────────────────────────
info "11/11 — Pare-feu, SELinux, Apache…"

if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
  success "Ports 80 et 443 ouverts"
else
  warn "firewalld inactif — vérifiez le pare-feu manuellement"
fi

if command -v setsebool &>/dev/null; then
  setsebool -P httpd_can_network_connect 1
  setsebool -P httpd_can_network_relay   1
  success "SELinux : httpd_can_network_connect activé"
fi

systemctl enable httpd
systemctl restart httpd
systemctl is-active --quiet httpd && success "Apache démarré" || error "Apache n'a pas démarré"

# ── Résumé ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  IPAM SIW v2 déployé avec succès !${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo ""
echo -e "  URL       : ${BLUE}https://${SERVER_IP}/${NC}"
echo -e "  Login     : admin"
echo -e "  Mot passe : SWI@IPAM2026\$"
echo ""
echo -e "${YELLOW}  Actions recommandées :${NC}"
echo    "  1. Changez le mot de passe admin à la première connexion"
echo    "  2. Remplacez le certificat SSL auto-signé"
echo    "  3. Logs Node.js : journalctl -u ipam -f"
echo    "  4. Logs Redis   : journalctl -u redis -f"
echo    "  5. Sauvegarde Redis : redis-cli BGSAVE"
echo    "  6. Page Configuration système accessible via Administration → Configuration"
echo ""
