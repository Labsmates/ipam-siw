# Restauration IPAM SIW — Sauvegarde Redis

Le fichier `.rdb` contient **toutes** les données Redis en mémoire au moment de la sauvegarde.

## Données récupérées

| Données | Clés Redis | Récupérées |
|---|---|---|
| Sites | `site:{id}`, `SMEMBERS sites` | ✅ |
| VLANs | `vlan:{id}`, `SMEMBERS vlans` | ✅ |
| IPs (statut + hostname) | `ip:{id}`, `SMEMBERS ips` | ✅ |
| Utilisateurs | `user:{id}`, `users:idx:username` | ✅ |
| Mots de passe (hachés SHA-256) | dans `user:{id}` | ✅ |
| Journaux d'activité | `LRANGE logs` | ✅ |
| Config DNS / route / codes site | `config:infos` | ✅ |
| Clé secrète JWT | `config:jwt_secret` | ✅ |
| Clés de bypass | `bypass:{key}` | ✅ |
| Bases de données / APIs configurées | `config:databases`, `config:apis` | ✅ |

---

## Option 1 — Restauration depuis l'interface (recommandée)

Depuis `/config.html` → onglet **Sauvegarde / Restauration** → **Restaurer depuis un fichier .rdb**.

- Sélectionner le fichier `.rdb`
- Le serveur valide les magic bytes `REDIS` avant d'écrire
- Redis redémarre automatiquement après la restauration

---

## Option 2 — Restauration en ligne de commande

```bash
# 1. Arrêter Redis
systemctl stop redis

# 2. Remplacer le fichier RDB
cp /chemin/vers/ipam_backup.rdb /var/lib/redis/ipam.rdb
chown redis:redis /var/lib/redis/ipam.rdb
chmod 660 /var/lib/redis/ipam.rdb

# 3. Redémarrer Redis
systemctl start redis

# 4. Vérifier
redis-cli PING          # → PONG
redis-cli SCARD sites   # → nombre de sites
redis-cli SCARD ips     # → nombre d'IPs
redis-cli SCARD users   # → nombre d'utilisateurs

# 5. Redémarrer IPAM
systemctl restart ipam
```

---

## Remarques

### Mots de passe
Les mots de passe sont stockés **hachés SHA-256** — jamais en clair. Après restauration, chaque utilisateur se connecte normalement avec son mot de passe habituel.

### Clé JWT
La clé secrète JWT est aussi restaurée depuis le `.rdb`. Les tokens de session existants restent valides après restauration.

### Emplacement du fichier RDB
Par défaut : `/var/lib/redis/ipam.rdb`
Configurable dans `deploy/redis.conf` (directive `dbfilename` + `dir`).

### Créer une sauvegarde manuelle

```bash
# Snapshot non bloquant
redis-cli BGSAVE
redis-cli LASTSAVE    # timestamp du dernier snapshot

# Copier le fichier
cp /var/lib/redis/ipam.rdb /backup/ipam_$(date +%Y-%m-%d_%H%M).rdb
```

Ou depuis l'interface : `/config.html` → onglet **Sauvegarde / Restauration** → **Déclencher une sauvegarde** puis **Télécharger**.
