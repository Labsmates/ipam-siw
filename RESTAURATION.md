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

---

## Migration Redis 7.x → 8.x

Le format `.rdb` est rétrocompatible — Redis 8.x lit nativement les fichiers générés par Redis 7.x. Aucune conversion nécessaire.

---

## Restauration avec AOF activé — Procédure complète

> **Problème fréquent :** si AOF est activé, Redis charge l'AOF en priorité sur le RDB au démarrage. Le RDB importé est ignoré et les données n'apparaissent pas.

### Vérifier si AOF est actif

```bash
redis-cli CONFIG_IPAM_ADMIN GET appendonly
# → "yes" = AOF actif, suivre la procédure ci-dessous
# → "no"  = procédure standard suffisante
```

### Procédure complète avec AOF

```bash
# 1. Désactiver AOF à chaud
redis-cli CONFIG_IPAM_ADMIN SET appendonly no

# 2. Arrêter Redis
systemctl stop redis

# 3. Désactiver AOF dans redis.conf (persiste au redémarrage)
sed -i 's/^appendonly yes/appendonly no/' /etc/redis/redis.conf
grep appendonly /etc/redis/redis.conf   # vérifier → "appendonly no"

# 4. Supprimer les fichiers AOF existants (format Multi-Part AOF Redis 7+)
rm -f /var/lib/redis/appendonlydir/ipam.aof.*
# Note : le dossier s'appelle "appendonlydir" (pas "appendonly")

# 5. Copier le fichier RDB
cp /chemin/vers/ipam_backup.rdb /var/lib/redis/ipam.rdb
chown redis:redis /var/lib/redis/ipam.rdb
chmod 660 /var/lib/redis/ipam.rdb

# 6. Vérifier le nom du fichier RDB attendu par Redis
grep dbfilename /etc/redis/redis.conf   # doit retourner "ipam.rdb"

# 7. Démarrer Redis (charge le RDB uniquement, AOF désactivé)
systemctl start redis

# 8. Vérifier que les données sont bien chargées
redis-cli PING
redis-cli SCARD sites
redis-cli SCARD ips
redis-cli SCARD users

# 9. Réactiver AOF à chaud — Redis recrée les fichiers automatiquement
redis-cli CONFIG_IPAM_ADMIN SET appendonly yes

# 10. Attendre la fin de la réécriture AOF
redis-cli INFO persistence | grep aof_rewrite_in_progress
# → 0 = terminé

# 11. Rendre permanent dans redis.conf
redis-cli CONFIG_IPAM_ADMIN REWRITE

# 12. Vérifier
grep appendonly /etc/redis/redis.conf   # doit retourner "appendonly yes"

# 13. Redémarrer IPAM
systemctl restart ipam
```

---

## Troubleshooting

### Aucune donnée après restauration (`SCARD sites` → 0)

**Cause la plus fréquente :** AOF activé — Redis a ignoré le RDB et rechargé depuis l'AOF vide.

```bash
# Diagnostic
redis-cli INFO persistence | grep -E "rdb_last_load_keys_loaded|aof_enabled"
# rdb_last_load_keys_loaded:0  → RDB non chargé (AOF prioritaire)
# aof_enabled:1                → AOF actif
```

→ Suivre la **Procédure complète avec AOF** ci-dessus.

---

### `CONFIG SET appendonly no` non reconnu

Sur cette installation, la commande `CONFIG` est renommée pour des raisons de sécurité :

```bash
# Utiliser la commande renommée
redis-cli CONFIG_IPAM_ADMIN SET appendonly no
redis-cli CONFIG_IPAM_ADMIN GET appendonly
redis-cli CONFIG_IPAM_ADMIN REWRITE
```

---

### Le RDB importé fait moins de 1 Ko — données vides

```bash
ls -la /var/lib/redis/ipam.rdb
# Si < 100 octets → fichier RDB vide généré par Redis au démarrage
```

Le fichier importé n'est pas le bon backup. Chercher le fichier original :

```bash
find / -name "*.rdb" -not -path "/proc/*" 2>/dev/null
ls -la /tmp/*.rdb 2>/dev/null
```

Si le backup est sur la machine locale (Windows), le transférer vers le serveur :

```bash
# Depuis Windows (PowerShell ou Git Bash)
scp C:\Users\Peyrius\Downloads\ipam.rdb root@<IP_SERVEUR>:/var/lib/redis/ipam.rdb

# Puis corriger les permissions
chown redis:redis /var/lib/redis/ipam.rdb
chmod 660 /var/lib/redis/ipam.rdb
```

---

### Format Multi-Part AOF (Redis 7+)

Redis 7+ utilise un dossier `appendonlydir/` au lieu d'un seul fichier `.aof` :

```
/var/lib/redis/appendonlydir/
├── ipam.aof.1.base.rdb
├── ipam.aof.1.incr.aof
└── ipam.aof.manifest
```

Supprimer avec :

```bash
rm -f /var/lib/redis/appendonlydir/ipam.aof.*
```
