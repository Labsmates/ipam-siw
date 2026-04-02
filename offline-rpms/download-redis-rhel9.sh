#!/bin/bash
# ==============================================================================
# Téléchargement offline de Redis 7.2 pour RHEL 9 / Rocky 9 x86_64
# Redis Sentinel est INCLUS dans le package redis (pas de package séparé)
#
# Usage : bash offline-rpms/download-redis-rhel9.sh
# Les RPMs seront téléchargés dans offline-rpms/redis-rhel9/
# ==============================================================================

set -e

OUTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redis-rhel9"
mkdir -p "$OUTDIR"

echo "[INFO] Téléchargement de Redis 7.2 (+ Sentinel) pour RHEL 9 dans $OUTDIR"

dnf download --resolve --destdir="$OUTDIR" redis

echo ""
echo "[OK] Fichiers téléchargés :"
ls -lh "$OUTDIR"/*.rpm 2>/dev/null

echo ""
echo "[INFO] Pour installer sur le serveur cible (hors ligne) :"
echo "  scp offline-rpms/redis-rhel9/*.rpm root@SERVEUR:/tmp/"
echo "  ssh root@SERVEUR 'dnf install -y /tmp/redis*.rpm'"
echo ""
echo "[INFO] Sentinel est inclus dans redis — pour l'activer :"
echo "  systemctl enable --now redis-sentinel"
echo "  systemctl status redis-sentinel"
