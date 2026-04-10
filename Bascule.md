# IPAM SIW — Procédure de bascule (Failover)

**Serveur 1 (actif)** : `218.16.185.50` — `ipam-siw.intra.laposte.fr`
**Serveur 2 (standby)** : `218.14.26.79` — `ipam-siw-slave.intra.laposte.fr`

---

## Architecture de bascule

```
Nominal :
  Utilisateurs → ipam-siw.intra.laposte.fr (218.16.185.50)
                       │
                  Redis MASTER
                       │ réplication async temps réel
                  Redis REPLICA (218.14.26.79)

Panne Serveur 1 :
  Redis Sentinel détecte (5s) → promeut Serveur 2 en MASTER
  Utilisateurs → ipam-siw-slave.intra.laposte.fr (218.14.26.79)
  Données intactes (réplication temps réel)

Retour Serveur 1 :
  Redevient REPLICA → resynchronisation automatique
  Utilisateurs retournent sur ipam-siw.intra.laposte.fr
```

> Sans contrôle DNS sur `intra.laposte.fr`, la bascule est **semi-automatique** :
> Sentinel promeut Redis automatiquement. L'URL utilisateur doit être changée manuellement
> vers `ipam-siw-slave.intra.laposte.fr`.

---

## Étape 1 — Configurer Redis Sentinel sur les deux serveurs

### 1.1 — Sur Serveur 1 (218.16.185.50)

```bash
cat > /etc/redis/sentinel.conf << 'EOF'
port 26379
bind 0.0.0.0
protected-mode no

sentinel monitor ipam-master 218.16.185.50 6379 1
sentinel down-after-milliseconds ipam-master 5000
sentinel failover-timeout ipam-master 60000
sentinel parallel-syncs ipam-master 1
EOF
```

```bash
systemctl enable --now redis-sentinel
systemctl status redis-sentinel
```

### 1.2 — Sur Serveur 2 (218.14.26.79)

```bash
cat > /etc/redis/sentinel.conf << 'EOF'
port 26379
bind 0.0.0.0
protected-mode no

sentinel monitor ipam-master 218.16.185.50 6379 1
sentinel down-after-milliseconds ipam-master 5000
sentinel failover-timeout ipam-master 60000
sentinel parallel-syncs ipam-master 1
EOF
```

```bash
systemctl enable --now redis-sentinel
systemctl status redis-sentinel
```

### 1.3 — Ouvrir le port Sentinel dans le firewall (si applicable)

```bash
# Sur Serveur 1 ET Serveur 2
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="218.16.185.50" port protocol="tcp" port="26379" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="218.14.26.79" port protocol="tcp" port="26379" accept'
firewall-cmd --reload
```

### 1.4 — Vérifier que Sentinel surveille bien le master

```bash
# Sur Serveur 1 ET Serveur 2
redis-cli -p 26379 sentinel masters
# → name: ipam-master
# → ip: 218.16.185.50
# → port: 6379
# → status: ok
# → num-slaves: 1

redis-cli -p 26379 sentinel slaves ipam-master
# → ip: 218.14.26.79
```

---

## Étape 2 — Connecter l'application Node.js à Sentinel

L'application doit se connecter via Sentinel (pas directement à Redis) pour basculer automatiquement en cas de failover.

### 2.1 — Modifier `server/redis.mjs`

Remplacer le bloc de connexion :

```js
// AVANT (connexion directe)
export const redis = new Redis({
  host:     process.env.REDIS_HOST     || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db:       parseInt(process.env.REDIS_DB   || '0'),
  retryStrategy: (times) => Math.min(times * 200, 5000),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});
```

```js
// APRÈS (connexion via Sentinel)
export const redis = new Redis({
  sentinels: [
    { host: process.env.SENTINEL_HOST_1 || '218.16.185.50', port: parseInt(process.env.SENTINEL_PORT || '26379') },
    { host: process.env.SENTINEL_HOST_2 || '218.14.26.79',  port: parseInt(process.env.SENTINEL_PORT || '26379') },
  ],
  name:           process.env.SENTINEL_NAME || 'ipam-master',
  db:             parseInt(process.env.REDIS_DB || '0'),
  retryStrategy:  (times) => Math.min(times * 200, 5000),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});
```

### 2.2 — Mettre à jour le `.env` sur les deux serveurs

```bash
# Ajouter dans /var/www/ipam/.env sur Serveur 1 ET Serveur 2
SENTINEL_HOST_1=218.16.185.50
SENTINEL_HOST_2=218.14.26.79
SENTINEL_PORT=26379
SENTINEL_NAME=ipam-master
```

> Les variables `REDIS_HOST` et `REDIS_PORT` ne sont plus utilisées, elles peuvent rester sans effet.

### 2.3 — Redémarrer l'application

```bash
# Sur Serveur 1 ET Serveur 2
systemctl restart ipam
journalctl -u ipam -n 20 --no-pager | grep -i "redis\|sentinel\|connect"
# → [Redis] Connecté
```

---

## Étape 3 — Configurer le notify script Keepalived

Le script alerte via syslog quand un basculement se produit.

### 3.1 — Créer le script sur les deux serveurs

```bash
cat > /etc/keepalived/notify.sh << 'EOF'
#!/bin/bash
TYPE=$1
NAME=$2
STATE=$3
DATE=$(date '+%Y-%m-%d %H:%M:%S')
HOSTNAME=$(hostname)
LOG=/var/log/keepalived-notify.log

echo "[$DATE] $HOSTNAME — $NAME est passé en état : $STATE" >> $LOG

case $STATE in
  MASTER)
    logger -t keepalived -p daemon.crit "FAILOVER : $HOSTNAME est devenu MASTER — ACTION REQUISE : pointer les utilisateurs vers ipam-siw-slave.intra.laposte.fr (218.14.26.79)"
    echo "[$DATE] ACTION REQUISE : pointer les utilisateurs vers ipam-siw-slave.intra.laposte.fr (218.14.26.79)" >> $LOG
    ;;
  BACKUP)
    logger -t keepalived -p daemon.info "RETOUR : $HOSTNAME est repassé en BACKUP — les utilisateurs peuvent revenir sur ipam-siw.intra.laposte.fr"
    echo "[$DATE] INFO : $HOSTNAME repassé en BACKUP — retour sur ipam-siw.intra.laposte.fr" >> $LOG
    ;;
  FAULT)
    logger -t keepalived -p daemon.err "FAULT : $HOSTNAME — service défaillant"
    echo "[$DATE] FAULT : $HOSTNAME — vérifier httpd et ipam" >> $LOG
    ;;
esac
EOF

chmod +x /etc/keepalived/notify.sh
```

### 3.2 — Vérifier les logs en temps réel

```bash
tail -f /var/log/keepalived-notify.log
journalctl -t keepalived -f
```

---

## Étape 4 — Config Keepalived finale (avec notify)

### Serveur 1 — `/etc/keepalived/keepalived.conf`

```
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
  interface ens3
  virtual_router_id 51
  priority 110
  advert_int 1
  unicast_src_ip 218.16.185.50
  unicast_peer {
    218.14.26.79
  }
  authentication {
    auth_type PASS
    auth_pass ipam-siw_ha_2026
  }
  virtual_ipaddress {
    218.16.185.254/24
  }
  notify /etc/keepalived/notify.sh
  track_script {
    chk_httpd
    chk_node
  }
}
```

### Serveur 2 — `/etc/keepalived/keepalived.conf`

```
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
  interface ens3
  virtual_router_id 51
  priority 90
  advert_int 1
  unicast_src_ip 218.14.26.79
  unicast_peer {
    218.16.185.50
  }
  authentication {
    auth_type PASS
    auth_pass ipam-siw_ha_2026
  }
  virtual_ipaddress {
    218.16.185.254/24
  }
  notify /etc/keepalived/notify.sh
  track_script {
    chk_httpd
    chk_node
  }
}
```

```bash
# Appliquer sur les deux serveurs
systemctl restart keepalived
```

---

## Étape 5 — Tester le failover complet

### 5.1 — Simuler la panne du Serveur 1

```bash
# Sur Serveur 1
systemctl stop ipam
systemctl stop httpd
```

### 5.2 — Vérifier que Sentinel a promu Serveur 2

```bash
# Sur Serveur 2 (attendre ~5 secondes)
redis-cli INFO replication | grep role
# → role:master

# Vérifier le log de bascule
tail /var/log/keepalived-notify.log
# → ACTION REQUISE : pointer les utilisateurs vers ipam-siw-slave.intra.laposte.fr
```

### 5.3 — Vérifier que l'application répond sur Serveur 2

```bash
curl -k https://ipam-siw-slave.intra.laposte.fr
# → page IPAM disponible avec toutes les données intactes
```

### 5.4 — Restaurer Serveur 1

```bash
# Sur Serveur 1
systemctl start httpd
systemctl start ipam
systemctl restart redis        # redevient REPLICA automatiquement
systemctl restart keepalived   # reprend la priorité MASTER Keepalived
```

```bash
# Vérifier resynchronisation Redis
redis-cli INFO replication | grep -E "role|master_link_status"
# → role:slave
# → master_link_status:up
```

---

## Procédure de bascule manuelle (résumé opérationnel)

| Étape | Action | Où |
|-------|--------|----|
| 1 | Sentinel promeut Serveur 2 automatiquement | Automatique |
| 2 | Vérifier `role:master` sur Serveur 2 | `redis-cli INFO replication` |
| 3 | Communiquer aux utilisateurs l'URL de secours | `ipam-siw-slave.intra.laposte.fr` |
| 4 | Réparer Serveur 1 | — |
| 5 | Redémarrer les services sur Serveur 1 | `systemctl start httpd ipam redis keepalived` |
| 6 | Vérifier resynchronisation Redis | `redis-cli INFO replication` |
| 7 | Communiquer retour sur URL nominale | `ipam-siw.intra.laposte.fr` |

---

## Récapitulatif des ports supplémentaires

| Port | Protocole | Usage |
|------|-----------|-------|
| 26379 | TCP | Redis Sentinel (entre les deux serveurs) |
