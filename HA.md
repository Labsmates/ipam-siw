# IPAM SIW — Haute Disponibilité (HA)

**Serveur 1 (actif)** : `218.16.185.50`
**Serveur 2 (passif / standby)** : `218.14.14.50`
**IP virtuelle flottante (VIP)** : à définir (ex: `218.16.185.100`)

---

## Architecture cible

```
           Utilisateurs
               │
        ┌──────┴──────┐
        │  VIP (VRRP) │  ← IP flottante (Keepalived)
        │ 218.16.185.x│
        └──────┬──────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼────────┐     ┌──────▼──────┐
│ Serveur 1  │     │  Serveur 2  │
│ ACTIF      │     │  STANDBY    │
│218.16.185.50     │218.14.14.50 │
│Apache+Node │     │Apache+Node  │
│Redis MASTER│────▶│Redis REPLICA│
└────────────┘     └─────────────┘
        │
    Réplication
    Redis async
```

- **Keepalived (VRRP)** gère la VIP : en cas de panne du Serveur 1, la VIP bascule automatiquement sur le Serveur 2 en moins de 3 secondes.
- **Redis** fonctionne en mode Master → Replica (réplication en temps réel). Si le Serveur 1 tombe, on promeut manuellement (ou via Sentinel) le Serveur 2 en master.
- Les fichiers applicatifs (code Node.js, config Apache) sont identiques sur les deux serveurs.

---

## Étape 1 — Déployer IPAM sur les deux serveurs

### Sur Serveur 1 (218.16.185.50)

```bash
# Déploiement standard (voir README.md)
bash deploy/deploy.sh
```

### Sur Serveur 2 (218.14.14.50)

Même procédure exacte :

```bash
bash deploy/deploy.sh
```

> Les deux serveurs doivent avoir **le même code, la même version**, les mêmes fichiers dans `/var/www/ipam/`.

---

## Étape 1.5 — Synchroniser le certificat SSL sur le Serveur 2

Le certificat SSL (`ipam.crt` + `ipam.key`) est émis pour `ipam-siw.intra.laposte.fr`.
Dans le setup HA, **les deux serveurs répondent à ce même nom de domaine** — ils doivent donc avoir **exactement le même certificat**.

### Pourquoi c'est obligatoire

Le DNS `ipam-siw.intra.laposte.fr` pointe vers la **VIP** (`218.16.185.100`).
Quand la VIP bascule du Serveur 1 vers le Serveur 2, c'est Apache du Serveur 2 qui répond.
Si le certificat est absent ou différent sur Serveur 2, les navigateurs afficheront `NET::ERR_CERT_INVALID`.

### 1.5.1 — Copier le certificat du Serveur 1 vers le Serveur 2

```bash
# Depuis Serveur 1 (ou depuis votre poste)
scp /var/www/ipam/data/ipam.crt root@218.14.14.50:/var/www/ipam/data/ipam.crt
scp /var/www/ipam/data/ipam.key root@218.14.14.50:/var/www/ipam/data/ipam.key
```

### 1.5.2 — Appliquer les bons droits sur Serveur 2

```bash
# Sur Serveur 2
chown root:root /var/www/ipam/data/ipam.crt /var/www/ipam/data/ipam.key
chmod 644 /var/www/ipam/data/ipam.crt
chmod 600 /var/www/ipam/data/ipam.key

# Vérifier que le certificat est valide et correspond bien au domaine
openssl x509 -noout -subject -issuer -dates -in /var/www/ipam/data/ipam.crt
# → subject=CN=ipam-siw.intra.laposte.fr
```

### 1.5.3 — Vérifier que la config Apache est identique sur Serveur 2

La config Apache (`/etc/httpd/conf.d/ipam.conf`) doit être la même sur les deux serveurs et pointer vers :

```apache
SSLCertificateFile    /var/www/ipam/data/ipam.crt
SSLCertificateKeyFile /var/www/ipam/data/ipam.key
```

```bash
# Sur Serveur 2 — tester la config et recharger
httpd -t && systemctl reload httpd
```

### 1.5.4 — DNS : pointer vers la VIP (pas les IPs des serveurs)

Le DNS interne doit pointer `ipam-siw.intra.laposte.fr` vers la **VIP**, pas vers l'IP d'un serveur spécifique :

```
ipam-siw.intra.laposte.fr  →  218.16.185.100   ← VIP Keepalived
```

Si le DNS pointait vers `218.16.185.50` (Serveur 1), les clients perdront l'accès pendant un basculement. Avec la VIP, le basculement est **transparent** pour les utilisateurs.

### 1.5.5 — Renouvellement de certificat

À chaque renouvellement du certificat, répéter la copie sur les deux serveurs :

```bash
# Depuis Serveur 1 après renouvellement
scp /var/www/ipam/data/ipam.crt root@218.14.14.50:/var/www/ipam/data/ipam.crt
scp /var/www/ipam/data/ipam.key root@218.14.14.50:/var/www/ipam/data/ipam.key
ssh root@218.14.14.50 "httpd -t && systemctl reload httpd"
```

---

## Étape 2 — Synchronisation des données Redis

### 2.1 — Exporter les données du Serveur 1

```bash
# Sur Serveur 1
redis-cli BGSAVE
cp /var/lib/redis/ipam.rdb /tmp/ipam_init.rdb
```

### 2.2 — Transférer le dump vers le Serveur 2

```bash
# Depuis Serveur 1 (ou votre poste)
scp root@218.16.185.50:/tmp/ipam_init.rdb root@218.14.14.50:/tmp/ipam_init.rdb
```

### 2.3 — Restaurer sur Serveur 2

```bash
# Sur Serveur 2
systemctl stop redis
cp /tmp/ipam_init.rdb /var/lib/redis/ipam.rdb
chown redis:redis /var/lib/redis/ipam.rdb
chmod 660 /var/lib/redis/ipam.rdb
systemctl start redis

# Vérifier
redis-cli PING          # → PONG
redis-cli SCARD sites   # → même valeur que Serveur 1
redis-cli SCARD users   # → même valeur
```

---

## Étape 3 — Configurer la réplication Redis

### 3.1 — Ouvrir le port Redis entre les deux serveurs

```bash
# Sur Serveur 1 ET Serveur 2
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="218.16.185.50" port protocol="tcp" port="6379" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="218.14.14.50" port protocol="tcp" port="6379" accept'
firewall-cmd --reload
```

### 3.2 — Sécuriser Redis avec un mot de passe

```bash
# Sur Serveur 1 — éditer /etc/redis/redis.conf (ou /var/www/ipam/deploy/redis.conf)
# Ajouter / modifier :
requirepass VotreMotDePasseRedisHA
bind 0.0.0.0
protected-mode no
```

```bash
# Appliquer
systemctl restart redis

# Tester
redis-cli -a VotreMotDePasseRedisHA PING
```

Répéter la même configuration sur le **Serveur 2**.

### 3.3 — Déclarer le Serveur 2 comme Replica du Serveur 1

```bash
# Sur Serveur 2 uniquement
redis-cli -a VotreMotDePasseRedisHA REPLICAOF 218.16.185.50 6379

# Configurer le mot de passe master dans redis.conf
echo "masterauth VotreMotDePasseRedisHA" >> /etc/redis/redis.conf
echo "replicaof 218.16.185.50 6379" >> /etc/redis/redis.conf
systemctl restart redis
```

### 3.4 — Vérifier la réplication

```bash
# Sur Serveur 1
redis-cli -a VotreMotDePasseRedisHA INFO replication
```

Résultat attendu :
```
role:master
connected_slaves:1
slave0:ip=218.14.14.50,port=6379,state=online,offset=...,lag=0
```

```bash
# Sur Serveur 2
redis-cli -a VotreMotDePasseRedisHA INFO replication
```

Résultat attendu :
```
role:slave
master_host:218.16.185.50
master_port:6379
master_link_status:up
```

> **Important** : mettre à jour la variable de connexion Redis dans `server/redis.mjs` si vous utilisez le mot de passe :
> ```js
> const redis = new Redis({ host: '127.0.0.1', port: 6379, password: 'VotreMotDePasseRedisHA' });
> ```

---

## Étape 4 — Installer et configurer Keepalived (VIP flottante)

### 4.0 — Installation hors ligne des RPMs (si les serveurs n'ont pas accès internet)

Les RPMs sont disponibles dans `offline-rpms/keepalived-rhel9/` et `offline-rpms/redis-rhel9/`.

#### Transfert vers les serveurs

```bash
# Depuis votre poste — copier les RPMs sur les deux serveurs
scp offline-rpms/keepalived-rhel9/*.rpm root@218.16.185.50:/tmp/keepalived/
scp offline-rpms/keepalived-rhel9/*.rpm root@218.14.14.50:/tmp/keepalived/

scp offline-rpms/redis-rhel9/*.rpm root@218.16.185.50:/tmp/redis/
scp offline-rpms/redis-rhel9/*.rpm root@218.14.14.50:/tmp/redis/
```

#### Installation de Redis 7.2 (avec Sentinel inclus)

```bash
# Sur Serveur 1 ET Serveur 2
mkdir -p /tmp/redis
# (après scp ci-dessus)
dnf install -y /tmp/redis/redis-*.rpm

# Vérifier
redis-server --version   # → Redis server v=7.2.x
redis-sentinel --version # → Redis sentinel v=7.2.x
```

#### Installation de Keepalived

```bash
# Sur Serveur 1 ET Serveur 2
mkdir -p /tmp/keepalived
# (après scp ci-dessus)
dnf install -y \
  /tmp/keepalived/ipset-libs-*.rpm \
  /tmp/keepalived/ipset-*.rpm \
  /tmp/keepalived/libnl3-3*.rpm \
  /tmp/keepalived/libnl3-cli-*.rpm \
  /tmp/keepalived/keepalived-*.rpm

# Vérifier
keepalived --version   # → Keepalived v2.2.8
```

> **Ordre important** : installer `ipset-libs` avant `ipset`, et `libnl3` avant `libnl3-cli`, pour éviter les erreurs de dépendances.

---

### 4.1 — Installation sur les deux serveurs (avec accès internet)

```bash
# Sur Serveur 1 ET Serveur 2
dnf install -y keepalived
```

### 4.2 — Configuration Serveur 1 (MASTER)

```bash
cat > /etc/keepalived/keepalived.conf << 'EOF'
global_defs {
  router_id IPAM_HA
}

vrrp_script chk_httpd {
  script "/usr/bin/systemctl is-active httpd"
  interval 2
  weight   -20
  fall     2
  rise     1
}

vrrp_script chk_node {
  script "/usr/bin/systemctl is-active ipam"
  interval 2
  weight   -20
  fall     2
  rise     1
}

vrrp_instance VI_IPAM {
  state  MASTER
  interface eth0            # ← adapter : ip link show pour trouver l'interface
  virtual_router_id 51
  priority 110              # Serveur 1 a une priorité plus haute
  advert_int 1
  authentication {
    auth_type PASS
    auth_pass ipam_ha_2024  # ← changer ce mot de passe
  }
  virtual_ipaddress {
    218.16.185.100/24       # ← VIP à adapter à votre réseau
  }
  track_script {
    chk_httpd
    chk_node
  }
}
EOF
```

### 4.3 — Configuration Serveur 2 (BACKUP)

```bash
cat > /etc/keepalived/keepalived.conf << 'EOF'
global_defs {
  router_id IPAM_HA
}

vrrp_script chk_httpd {
  script "/usr/bin/systemctl is-active httpd"
  interval 2
  weight   -20
  fall     2
  rise     1
}

vrrp_script chk_node {
  script "/usr/bin/systemctl is-active ipam"
  interval 2
  weight   -20
  fall     2
  rise     1
}

vrrp_instance VI_IPAM {
  state  BACKUP
  interface eth0            # ← adapter
  virtual_router_id 51
  priority 90               # Priorité plus basse → devient actif uniquement si Serveur 1 tombe
  advert_int 1
  authentication {
    auth_type PASS
    auth_pass ipam_ha_2024  # ← même mot de passe que Serveur 1
  }
  virtual_ipaddress {
    218.16.185.100/24       # ← même VIP
  }
  track_script {
    chk_httpd
    chk_node
  }
}
EOF
```

### 4.4 — Activer Keepalived

```bash
# Sur Serveur 1 ET Serveur 2
systemctl enable --now keepalived
systemctl status keepalived
```

### 4.5 — Vérifier la VIP

```bash
# Sur Serveur 1 — la VIP doit être visible
ip addr show eth0 | grep 218.16.185.100
# → inet 218.16.185.100/24

# Sur Serveur 2 — la VIP ne doit PAS être visible (serveur passif)
ip addr show eth0 | grep 218.16.185.100
# → (aucun résultat)
```

---

## Étape 5 — Autoriser VRRP dans le firewall

```bash
# Sur Serveur 1 ET Serveur 2
firewall-cmd --permanent --add-protocol=vrrp
firewall-cmd --reload
```

---

## Étape 6 — Tester le basculement (failover)

### Test 1 — Arrêt du service sur Serveur 1

```bash
# Sur Serveur 1
systemctl stop httpd

# Sur votre poste — vérifier que la VIP répond encore (depuis Serveur 2)
curl -k https://218.16.185.100
# → La page IPAM s'affiche depuis Serveur 2
```

### Test 2 — Simuler une panne complète du Serveur 1

```bash
# Sur Serveur 1
systemctl stop keepalived

# Vérifier sur Serveur 2
ip addr show eth0 | grep 218.16.185.100
# → La VIP a migré sur Serveur 2
```

### Restauration après panne

```bash
# Remettre Serveur 1 en service
systemctl start httpd
systemctl start ipam
systemctl start keepalived

# La VIP revient automatiquement sur Serveur 1 (priorité 110 > 90)
```

---

## Étape 7 — Promotion Redis en cas de panne durable

Si le Serveur 1 est définitivement hors ligne et que vous voulez que le Serveur 2 accepte les écritures :

```bash
# Sur Serveur 2
redis-cli -a VotreMotDePasseRedisHA REPLICAOF NO ONE

# Vérifier
redis-cli -a VotreMotDePasseRedisHA INFO replication
# → role:master
```

Puis mettre à jour la configuration dans `/etc/redis/redis.conf` du Serveur 2 :

```bash
sed -i '/^replicaof/d' /etc/redis/redis.conf
sed -i '/^masterauth/d' /etc/redis/redis.conf
systemctl restart redis
```

Quand le Serveur 1 est remis en ligne, il devra devenir replica du Serveur 2 (ou inversement selon votre choix), puis vous pourrez re-synchroniser avec `BGSAVE` + `REPLICAOF`.

---

## Étape 8 — Synchronisation des fichiers applicatifs (mises à jour)

Lors d'une mise à jour de l'application, déployer sur les **deux serveurs** dans cet ordre :

```bash
# 1. Mettre à jour le Serveur 2 (passif) en premier
rsync -avz --delete /var/www/ipam/ root@218.14.14.50:/var/www/ipam/
ssh root@218.14.14.50 "systemctl restart ipam"

# 2. Mettre à jour le Serveur 1 (actif)
#    (brève coupure de quelques secondes, la VIP basculera sur Serveur 2 pendant le restart)
systemctl restart ipam
```

Ou avec `rsync` pour les fichiers statiques uniquement (sans interruption) :

```bash
rsync -avz /var/www/ipam/client/ root@218.14.14.50:/var/www/ipam/client/
```

---

## Récapitulatif des ports à ouvrir

| Port | Protocole | Source → Destination | Usage |
|------|-----------|----------------------|-------|
| 80   | TCP | Utilisateurs → VIP | HTTP (redirection HTTPS) |
| 443  | TCP | Utilisateurs → VIP | HTTPS |
| 6379 | TCP | 218.16.185.50 ↔ 218.14.14.50 | Réplication Redis |
| VRRP (112) | IP | 218.16.185.50 ↔ 218.14.14.50 | Keepalived VRRP |

---

## Récapitulatif des services à vérifier

```bash
# Sur chaque serveur
systemctl status httpd       # Apache (reverse proxy)
systemctl status ipam        # Node.js application
systemctl status redis       # Base de données
systemctl status keepalived  # Gestion VIP
```

---

## Limites de cette architecture

| Point | Détail |
|-------|--------|
| Réplication Redis | **Asynchrone** — en cas de panne soudaine, les dernières écritures (< 1s) peuvent être perdues |
| Promotion Redis | **Manuelle** — il faut intervenir pour promouvoir le Replica en Master. Pour l'automatiser, voir Redis Sentinel (ci-dessous) |
| Fichiers locaux | Les certificats SSL dans `/var/www/ipam/data/` doivent être copiés manuellement sur Serveur 2 |
| Sessions JWT | Les tokens sont auto-porteurs (JWT) — pas de problème lors d'un basculement |

---

## Option avancée — Redis Sentinel (promotion automatique)

Redis Sentinel surveille le master et promeut automatiquement le replica si le master est indisponible pendant plus de 5 secondes.

```bash
# Installer sur les deux serveurs
dnf install -y redis-sentinel   # ou redis (sentinel inclus)

# Configuration /etc/redis/sentinel.conf (sur les deux serveurs)
cat > /etc/redis/sentinel.conf << 'EOF'
port 26379
sentinel monitor ipam-master 218.16.185.50 6379 1
sentinel auth-pass ipam-master VotreMotDePasseRedisHA
sentinel down-after-milliseconds ipam-master 5000
sentinel failover-timeout ipam-master 60000
sentinel parallel-syncs ipam-master 1
EOF

systemctl enable --now redis-sentinel
```

> Avec Sentinel, si le Serveur 1 tombe pendant plus de 5 secondes, le Serveur 2 est automatiquement promu en master sans intervention manuelle.
