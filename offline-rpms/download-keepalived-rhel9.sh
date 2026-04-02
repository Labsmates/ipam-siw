#!/bin/bash
# ==============================================================================
# Téléchargement offline de keepalived + dépendances pour RHEL 9 / Rocky 9
# À lancer depuis une machine avec accès internet (RHEL 9 ou Rocky 9)
#
# Usage : bash offline-rpms/download-keepalived-rhel9.sh
# Les RPMs seront téléchargés dans offline-rpms/keepalived-rhel9/
# ==============================================================================

set -e

OUTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/keepalived-rhel9"
mkdir -p "$OUTDIR"

echo "[INFO] Téléchargement de keepalived et ses dépendances dans $OUTDIR"

# Télécharger keepalived + toutes ses dépendances (sans les installer)
dnf download --resolve --destdir="$OUTDIR" keepalived

echo ""
echo "[OK] Fichiers téléchargés :"
ls -lh "$OUTDIR"/*.rpm 2>/dev/null

echo ""
echo "[INFO] Pour installer sur le serveur cible (hors ligne) :"
echo "  scp offline-rpms/keepalived-rhel9/*.rpm root@SERVEUR:/tmp/"
echo "  ssh root@SERVEUR 'dnf install -y /tmp/keepalived*.rpm /tmp/lm_sensors*.rpm /tmp/ipset*.rpm'"
