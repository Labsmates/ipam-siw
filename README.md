# IPAM SIW v2.3.0 — Guide de déploiement Rocky Linux 10

Application web multi-utilisateurs de gestion des adresses IP — **SIW Pole Serveurs**.
Backend **Node.js + Redis** — déploiement 100 % hors-ligne, accessible depuis n'importe quel réseau.

---

## Architecture

```
Navigateur (LAN / WAN / Internet)
        │
   HTTPS :443  /  HTTP :80
        │
   Apache (httpd) — reverse proxy
   ├── Certificat SSL/TLS
   ├── En-têtes de sécurité (CSP, HSTS, X-Frame-Options…)
   ├── Blocage des fichiers sensibles (server/, deploy/, *.mjs…)
   └── ProxyPass → 127.0.0.1:3000
               │
          Node.js — server/index.mjs  (Express, localhost:3000)
          ├── POST /api/login          → JWT 24 h
          ├── GET  /api/sites          → liste des sites + stats
          ├── GET  /api/sites/:id      → détail site (VLANs + IPs)
          ├── /api/vlans               → CRUD VLANs
          ├── /api/ips                 → réservation / libération
          ├── /api/logs                → journal d'activité
          └── Fichiers statiques  client/  +  vendor/
                    │
               Redis 127.0.0.1:6379  — base de données (mémoire + AOF)
```

---

## Structure du projet

```
IPAMBBD/
├── client/
│   ├── index.html          ← Connexion
│   ├── dashboard.html      ← Liste des sites (grille avec stats)
│   ├── site.html           ← Détail site (sidebar + VLANs + IPs)
│   ├── stats.html          ← Statistiques globales
│   ├── archive.html        ← Archive des libérations
│   ├── export.html         ← Export Excel
│   ├── ipcalc.html         ← Calculateur IP (accessible à tous les utilisateurs)
│   ├── admin.html          ← Administration
│   ├── config.html         ← Configuration système (super admin uniquement)
│   ├── info.html           ← Informations réseau (visible tous les utilisateurs)
│   ├── css/
│   │   └── theme.css       ← Thème sombre / clair gris platine (variables CSS)
│   └── js/
│       ├── api.js          ← Fetch wrapper, JWT, toast, timer inactivité, initTheme
│       ├── auth.js         ← Login (redirige vers site.html)
│       ├── dashboard.js    ← Grille des sites
│       ├── site.js         ← Sidebar, table IPs, modals, suffixes hostname FQDN
│       ├── admin.js        ← Utilisateurs, sites, journaux, MDP
│       ├── ipcalc.js       ← Calculateur de sous-réseaux IP
│       ├── config.js       ← Services, config Redis, sauvegarde, bases de données
│       └── info.js         ← Informations réseau (DNS, route, domaines, codes site)
├── server/
│   ├── index.mjs           ← Serveur Express
│   ├── redis.mjs           ← Couche d'accès Redis
│   ├── utils.mjs           ← sha256, uid, now
│   ├── middleware/
│   │   └── auth.mjs        ← Vérification JWT (requireAuth, requireAdmin, requireSuperAdmin)
│   └── routes/
│       ├── auth.mjs        ← Login, utilisateurs, /me/password
│       ├── sites.mjs       ← CRUD sites, ajout VLAN (IPs auto), import
│       ├── vlans.mjs       ← CRUD VLANs
│       ├── ips.mjs         ← Réservation / libération
│       ├── logs.mjs        ← Journal d'activité
│       ├── config.mjs      ← Configuration système (super admin — services, Redis, backup, DB)
│       └── infos.mjs       ← Informations réseau (DNS DDI, route PSM, domaines, codes site)
├── vendor/
│   ├── tailwind.min.js     ← Tailwind CSS (offline)
│   ├── xlsx.full.min.js    ← SheetJS (offline)
│   ├── fonts/              ← Polices Inter + JetBrains Mono (offline)
│   ├── fonts.css
│   └── download-vendor.sh  ← Script de téléchargement (machine dev)
├── offline-rpms/           ← RPMs pour installation hors-ligne
│   ├── nodejs-22.22.0-3.el10_1.x86_64.rpm
│   ├── nodejs-libs-22.22.0-3.el10_1.x86_64.rpm
│   ├── nodejs-npm-10.9.4-1.22.22.0.3.el10_1.x86_64.rpm
│   ├── libuv-1.51.0-1.el10_0.x86_64.rpm
│   ├── redis-7.2.13-1.el10.remi.x86_64.rpm
│   └── logrotate-3.22.0-4.el10.x86_64.rpm
├── deploy/
│   ├── deploy.sh                    ← Script de déploiement automatisé
│   ├── setup-config-permissions.sh  ← Prérequis page Configuration (sudo + RDB)
│   ├── ipam.conf                    ← Apache Virtual Host
│   ├── ipam.service                 ← Service systemd Node.js
│   └── redis.conf                   ← Configuration Redis production
├── import_redis.py         ← Import Me.xlsx → Redis (voir section dédiée)
├── data/                   ← Créé automatiquement au premier démarrage
└── package.json
```

---

## Prérequis serveur

| Composant | Version | Source |
|---|---|---|
| Rocky Linux | 10 | — |
| Node.js | 22 LTS | `offline-rpms/` |
| Redis | 7.2 | `offline-rpms/` (Remi) |
| Apache + mod_ssl | 2.4 | dépôts Rocky 10 |

> Aucune connexion Internet requise sur le serveur — tout est fourni dans le projet.

---

## Étape 1 — Préparation (machine de développement)

### Bibliothèques JS (si pas encore téléchargées)

```bash
bash vendor/download-vendor.sh
```

### Modules Node.js

```bash
npm install
```

> `node_modules/` doit être inclus dans le transfert. ioredis est pur JS — pas de compilation.

### Transfert vers le serveur

```bash
scp -r IPAMBBD/ root@218.16.185.50:/tmp/ipam_src/
```

---

## Étape 2 — Déploiement sur Rocky Linux 10

### Option A — Script automatisé (recommandé)

```bash
ssh root@218.16.185.50
cd /tmp/ipam_src
bash deploy/deploy.sh
```

Le script effectue en une seule commande :

- Installation de Node.js, Redis, Apache depuis `offline-rpms/`
- Création de l'utilisateur système `ipam`
- Copie des fichiers dans `/var/www/ipam/`
- Configuration et démarrage de Redis
- Génération du certificat SSL auto-signé (10 ans)
- Configuration Apache (reverse proxy HTTPS + sécurité)
- Service systemd `ipam` avec démarrage automatique
- Ouverture des ports 80 et 443 (firewalld)
- Configuration SELinux

---

### Option B — Déploiement manuel

#### 1. Dépendances système

```bash
# Node.js, Redis, logrotate depuis les RPMs fournis
dnf install -y /tmp/ipam_src/offline-rpms/*.rpm

# Apache
dnf install -y httpd mod_ssl
```

#### 2. Utilisateur système

```bash
useradd -r -s /sbin/nologin -d /var/www/ipam ipam
```

#### 3. Copier les fichiers

```bash
mkdir -p /var/www/ipam
cp -r /tmp/ipam_src/{server,client,vendor,package.json,node_modules} /var/www/ipam/
```

#### 4. Redis

```bash
cp /tmp/ipam_src/deploy/redis.conf /etc/redis/redis.conf
systemctl enable --now redis
```

#### 5. Permissions

```bash
chown -R root:ipam /var/www/ipam
chmod 750 /var/www/ipam
usermod -aG ipam apache
```

#### 6. Certificat SSL

Les certificats sont stockés dans `/var/www/ipam/data/` (propriétaire `ipam:ipam`) — aucun accès root requis pour les renouveler via la page Configuration.

```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /var/www/ipam/data/ipam.key \
  -out    /var/www/ipam/data/ipam.crt \
  -subj   "/C=FR/ST=France/L=Paris/O=SIW/CN=218.16.185.50" \
  -addext "subjectAltName=IP:218.16.185.50"
chown ipam:ipam /var/www/ipam/data/ipam.key /var/www/ipam/data/ipam.crt
chmod 600 /var/www/ipam/data/ipam.key
```

#### 7. Apache

```bash
cp /tmp/ipam_src/deploy/ipam.conf /etc/httpd/conf.d/ipam.conf
httpd -t && systemctl enable --now httpd
```

#### 8. Service Node.js

```bash
cp /tmp/ipam_src/deploy/ipam.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ipam
```

#### 9. Pare-feu et SELinux

```bash
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
setsebool -P httpd_can_network_connect 1
setsebool -P httpd_can_network_relay   1
```

---

## Étape 3 — Import des données (Me.xlsx → Redis)

Le script `import_redis.py` importe automatiquement les 33 sites du fichier Excel
dans Redis (sites, VLANs, plages réseau, IPs avec statuts et hostnames).

**Résultat attendu : 33 sites · 108 VLANs · ~22 500 IPs**

### Prérequis Python (machine dev ou serveur)

```bash
pip install openpyxl redis
```

### Utilisation

```bash
# 1. Tester sans rien écrire (dry-run)
python3 import_redis.py --xlsx /chemin/vers/Me.xlsx --dry-run

# 2. Importer vers Redis local (serveur)
python3 import_redis.py --xlsx /chemin/vers/Me.xlsx

# 3. Importer vers Redis distant
python3 import_redis.py --xlsx Me.xlsx --host 218.16.185.50 --port 6379

# 4. Importer un seul site (test)
python3 import_redis.py --xlsx Me.xlsx --site BIOME --dry-run
```

### Options

| Option | Défaut | Description |
|---|---|---|
| `--xlsx` | `Me.xlsx` | Chemin du fichier Excel |
| `--host` | `127.0.0.1` | Hôte Redis |
| `--port` | `6379` | Port Redis |
| `--password` | _(vide)_ | Mot de passe Redis |
| `--dry-run` | _(désactivé)_ | Parser sans écrire |
| `--site` | _(tous)_ | Filtrer par nom de feuille |

> Le script est idempotent : si un site existe déjà (même nom), il est ignoré.

---

## Accès

| URL | Note |
|---|---|
| `https://218.16.185.50/` | HTTPS — recommandé |
| `http://218.16.185.50/` | Redirigé automatiquement vers HTTPS |

**Identifiants par défaut :**

| Identifiant | Mot de passe |
|---|---|
| `admin` | `SWI@IPAM2026$` |

> Changez le mot de passe admin dès la première connexion : **Administration → Mon mot de passe**

---

## Fonctionnalités

### Pages

| Page | URL | Accès | Description |
|---|---|---|---|
| Connexion | `/` | Public | Login JWT, redirection automatique si déjà connecté |
| Sites | `/site.html` | Auth | Sidebar avec tous les sites, état d'accueil si aucun site sélectionné |
| Détail site | `/site.html?id=N` | Auth | VLANs, table IPs paginée, réservation/libération, suffixe FQDN auto |
| Dashboard | `/dashboard.html` | Auth | Grille des sites avec stats (libres / occupées / total) |
| Statistiques | `/stats.html` | Auth | Statistiques globales par site et VLAN |
| Archive | `/archive.html` | Auth | Historique des libérations (hostname, IP, date, utilisateur) |
| Export Excel | `/export.html` | Auth | Export .xlsx multi-sites avec filtres colonnes et statut |
| Calculateur IP | `/ipcalc.html` | Auth | Calcul de sous-réseaux CIDR (plage, masque, broadcast, hosts) |
| Informations réseau | `/info.html` | Auth | DNS DDI, domaines, route PSM, codes site (lecture tous / édition admin) |
| Administration | `/admin.html` | Admin | Gestion utilisateurs, sites, journaux, changement MDP |
| Configuration système | `/config.html` | **Super admin** | Services, config Redis, sauvegarde/restauration, bases de données |

### Gestion des IPs

| Action | Qui | Description |
|---|---|---|
| Réserver | Tous (sauf viewer) | Passe une IP `Libre` → `Réservée` |
| Libérer | Tous (sauf viewer) | Passe une IP `Utilisé` ou `Réservée` → `Libre` |
| Renommer hostname | Tous (sauf viewer) | Modifier le hostname d'une IP existante |
| Ajouter un VLAN | Admin | Formulaire CIDR → génère automatiquement toutes les IPs hôtes |
| Import Excel | Admin | Fichier .xlsx colonne A = IP → marque les IPs correspondantes `Réservée` |

### Suffixe FQDN automatique

Lors de la réservation ou du renommage d'un hostname, le suffixe est appliqué automatiquement selon le tag VLAN (`description`) si l'utilisateur saisit un nom simple (sans point) :

| Tag VLAN | Suffixe appliqué |
|---|---|
| `METIER`, `FLUX`, `PROCEF`, `IPMI PROCEF` | `.dct.adt.local` |
| `ADMIN` | `.hdcadmin.sf.intra.laposte.fr` |
| `IPMI`, inconnu | Aucun — hostname saisi tel quel |

> Si l'utilisateur saisit un FQDN complet (contenant un point), il est utilisé sans modification.
> Un aperçu en temps réel est affiché sous le champ hostname pendant la saisie.

### Statuts IP

| Statut | Couleur | Description |
|---|---|---|
| `Libre` | Vert | IP disponible |
| `Utilisé` | Rouge | IP en service (hostname présent) |
| `Réservée` | Orange | IP réservée mais non déployée |

---

## Informations réseau (`/info.html`)

Page visible par **tous les utilisateurs authentifiés**. Les admins peuvent modifier toutes les valeurs directement depuis cette page (boutons ✎ inline).

### DNS DDI
| Champ | Valeur par défaut | Description |
|---|---|---|
| `dns1` | `194.5.88.5` | DNS primaire |
| `dns2` | `194.5.88.133` | DNS secondaire |
| `dns-dc` | `200.16.1.11` | DNS contrôleur de domaine |

**Domaines** — liste modifiable des domaines DNS (ajout, modification, suppression).
Valeurs par défaut : `dct.dat.local`, `hdcadmin.sf.intra.laposte.local`, `sf.intra.laposte.local`.

### Route vers PSM
| Champ | Valeur par défaut |
|---|---|
| `route` | `10.19.1.1:28` |

### Codes Site
Association entre un site IPAM et un code court (8 caractères max, majuscules).
- Tri alphabétique par nom de site
- Un site ne peut avoir qu'un seul code (l'entrée est grisée/barrée dans le sélecteur si déjà assignée)
- Bouton **Ajouter code site** → sélection du site + saisie du code

Toutes ces données sont **persistantes** dans Redis (clé `config:infos`).
Les modifications sont journalisées dans le journal d'activité admin.

---

## Configuration système (super admin)

La page `/config.html` est réservée au compte **ADMIN** (super administrateur). Elle offre 4 onglets :

### Services
- Statut en temps réel (actif / inactif / échoué) pour `ipam`, `httpd`, `redis`
- Boutons contextuels selon l'état du service :
  - **Démarrer** (vert) — visible si le service est inactif ou en erreur
  - **Redémarrer** (orange) — toujours disponible
  - **Arrêter** (rouge, confirmation) — visible si le service est actif
  - **Recharger** (httpd uniquement, si actif) — rechargement à chaud de la configuration Apache
- Consultation des **100 dernières lignes de logs** via `journalctl` (panneau dépliable)
- Rafraîchissement automatique toutes les 10 secondes

**Zone Actions serveur** (en bas de l'onglet, accessible à tous les admins) :
- **Redémarrer le serveur** — `shutdown -r +0`, confirmation obligatoire, indisponibilité ~1-2 min
- **Arrêter le serveur** — `shutdown -h +0`, confirmation obligatoire, redémarrage manuel requis
- Les deux actions sont journalisées (`SERVER_REBOOT` / `SERVER_HALT`) dans le journal admin

### Configuration Redis
- Lecture et modification en direct des paramètres Redis via `CONFIG_IPAM_ADMIN SET`
- Paramètres accessibles : `maxmemory`, `maxmemory-policy`, `appendonly`, `save`, `requirepass`, `loglevel`, `bind`
- ⚠ Les modifications sont appliquées **en mémoire uniquement** — éditer aussi `/etc/redis/redis.conf` pour les rendre permanentes

### Sauvegarde / Restauration
- Déclencher une sauvegarde BGSAVE non bloquante
- Télécharger le fichier `ipam.rdb` (nécessite Bearer token — géré automatiquement)
- Restaurer depuis un fichier `.rdb` (validation des magic bytes + redémarrage Redis automatique)

### Bases de données supplémentaires
- Ajouter des connexions Redis (nom, hôte, port, mot de passe, index DB)
- Tester la connectivité (PING avec latence)
- Synchroniser toutes les clés vers une instance cible (DUMP/RESTORE en cursor scan)

### Prérequis serveur

```bash
# Configurer sudo et les permissions RDB (inclus dans deploy.sh depuis v2.2.0)
bash deploy/setup-config-permissions.sh

# Puis redémarrer le service pour que le changement de groupe prenne effet
systemctl restart ipam
```

Le script crée :
- `/etc/sudoers.d/ipam` — commandes `systemctl` (start/stop/restart/reload/status), `journalctl` et `shutdown` sans mot de passe
- `ipam` ∈ groupe `redis` — accès en lecture/écriture au fichier RDB
- Permissions `664` sur `/var/lib/redis/ipam.rdb`

---

## Sécurité

### Apache

| Protection | Détail |
|---|---|
| HTTPS forcé | HTTP → HTTPS 301 |
| TLS 1.2+ | SSLv3, TLS 1.0/1.1 désactivés |
| CSP | Aucun CDN externe — tout servi localement |
| HSTS | 1 an, includeSubDomains |
| Fichiers bloqués | `server/`, `deploy/`, `*.mjs`, `*.sh` → 403 |

### Node.js

| Protection | Détail |
|---|---|
| Bind localhost | `127.0.0.1:3000` uniquement |
| JWT | Token Bearer, expiration 24 h |
| Mots de passe | Hachés SHA-256, jamais stockés en clair |
| Clé JWT | Générée aléatoirement au 1er démarrage |

### Redis

| Protection | Détail |
|---|---|
| Bind localhost | `127.0.0.1:6379` uniquement |
| FLUSHALL/FLUSHDB | Désactivés |
| Persistance AOF | Sauvegarde disque toutes les secondes |

### Page Configuration système

| Protection | Détail |
|---|---|
| Triple guard | `requireAuth` + `requireAdmin` + `requireSuperAdmin` (username === `ADMIN`) |
| Whitelist services | Seuls `ipam`, `httpd`, `redis` acceptés — injection shell impossible (`execFile`) |
| Sudo restreint | Commandes exactes autorisées via `/etc/sudoers.d/ipam` (start/stop/restart/reload/status + journalctl + shutdown) |
| Params Redis | Whitelist des clés modifiables — `bind` modifiable mais affiché avec avertissement |
| Restauration RDB | Validation des magic bytes `REDIS` avant écriture |
| Mots de passe DB | Jamais renvoyés au client dans les listings |

### Frontend

| Protection | Détail |
|---|---|
| Timeout inactivité | Déconnexion automatique après 20 minutes |
| Onglet inactif | Déconnexion si masqué > 20 minutes |
| sessionStorage | Token effacé à la fermeture du navigateur |

---

## Certificat SSL — CSR et autorité de certification (CA)

### Contexte

Le déploiement par défaut utilise un certificat **auto-signé** (avertissement navigateur inévitable).
Pour obtenir un certificat signé par votre CA d'entreprise, suivez les étapes ci-dessous.

---

### Étape 1 — Générer la clé privée et le CSR

```bash
# Créer le répertoire de travail
mkdir -p /etc/pki/tls/csr

# Générer la clé privée RSA 2048 bits
openssl genrsa -out /etc/pki/tls/private/ipam.key 2048
chmod 600 /etc/pki/tls/private/ipam.key

# Générer le CSR (Certificate Signing Request)
# Remplacer les valeurs C, ST, L, O, OU, CN par celles de votre organisation
openssl req -new \
  -key  /etc/pki/tls/private/ipam.key \
  -out  /etc/pki/tls/csr/ipam.csr \
  -subj "/C=FR/ST=France/L=Paris/O=SIW/OU=DSI/CN=ipam.siw.local"
```

> Le fichier `ipam.csr` est à transmettre à votre service PKI / autorité de certification interne.

---

### Étape 2 — CSR avec Subject Alternative Names (SAN)

Si le serveur est accessible par IP **et** par nom DNS, créer un fichier de configuration SAN :

```bash
cat > /tmp/ipam_san.cnf <<EOF
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
req_extensions     = req_ext

[dn]
C  = FR
ST = France
L  = Paris
O  = SIW
OU = DSI
CN = ipam.siw.local

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = ipam.siw.local
DNS.2 = ipam
IP.1  = 218.16.185.50
EOF

# Générer le CSR avec SAN
openssl req -new \
  -key    /etc/pki/tls/private/ipam.key \
  -out    /etc/pki/tls/csr/ipam.csr \
  -config /tmp/ipam_san.cnf

# Vérifier le contenu du CSR
openssl req -text -noout -in /etc/pki/tls/csr/ipam.csr
```

---

### Étape 3 — Signer le CSR avec votre CA interne (si vous êtes l'administrateur CA)

```bash
# Sur le serveur CA (ou en local si vous gérez la CA)
openssl x509 -req \
  -in      /etc/pki/tls/csr/ipam.csr \
  -CA      /etc/pki/CA/ca.crt \
  -CAkey   /etc/pki/CA/ca.key \
  -CAcreateserial \
  -out     /etc/pki/tls/certs/ipam.crt \
  -days    825 \
  -sha256 \
  -extfile /tmp/ipam_san.cnf \
  -extensions req_ext

# Vérifier le certificat signé
openssl x509 -text -noout -in /etc/pki/tls/certs/ipam.crt
openssl verify -CAfile /etc/pki/CA/ca.crt /etc/pki/tls/certs/ipam.crt
```

---

### Étape 4 — Installer le certificat signé sur le serveur IPAM

Une fois que votre CA vous a renvoyé le fichier `.crt` (et éventuellement la chaîne intermédiaire) :

```bash
# Copier le certificat signé
cp ipam.crt /etc/pki/tls/certs/ipam.crt
chmod 644   /etc/pki/tls/certs/ipam.crt

# Si la CA vous fournit aussi un certificat intermédiaire (chain)
# Concaténer : certificat serveur + intermédiaire
cat ipam.crt ca_intermediate.crt > /etc/pki/tls/certs/ipam_fullchain.crt

# Vérifier la cohérence clé / certificat (les deux hash doivent être identiques)
openssl rsa  -noout -modulus -in  /etc/pki/tls/private/ipam.key | openssl md5
openssl x509 -noout -modulus -in  /etc/pki/tls/certs/ipam.crt   | openssl md5

# Mettre à jour ipam.conf si vous utilisez la fullchain
# SSLCertificateFile    /etc/pki/tls/certs/ipam_fullchain.crt
# SSLCertificateKeyFile /etc/pki/tls/private/ipam.key

# Tester la configuration Apache puis recharger
httpd -t && systemctl reload httpd
```

---

### Étape 5 — Déployer le certificat CA sur les postes clients (optionnel)

Pour supprimer l'avertissement navigateur sur les machines du parc :

```bash
# Rocky Linux / RHEL — déployer la CA sur le serveur lui-même ou les clients
cp ca.crt /etc/pki/ca-trust/source/anchors/siw-ca.crt
update-ca-trust extract

# Vérification
openssl s_client -connect 218.16.185.50:443 -CAfile /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
```

> **Windows (GPO)** : importer `ca.crt` dans *Autorités de certification racines de confiance* via `certmgr.msc` ou une GPO `Computer Configuration → Windows Settings → Security Settings → Public Key Policies`.

---

### Renouvellement du certificat

```bash
# 1. Vérifier la date d'expiration
openssl x509 -enddate -noout -in /etc/pki/tls/certs/ipam.crt

# 2. Regénérer un CSR avec la clé existante (pas besoin de nouvelle clé)
openssl req -new \
  -key    /etc/pki/tls/private/ipam.key \
  -out    /etc/pki/tls/csr/ipam_renew.csr \
  -config /tmp/ipam_san.cnf

# 3. Soumettre ipam_renew.csr à la CA
# 4. Installer le nouveau certificat (Étape 4 ci-dessus)
# 5. Recharger Apache
systemctl reload httpd
```

---

## Gestion Redis — Référence complète

### Connexion et statut

```bash
# Ouvrir la CLI Redis
redis-cli

# Statut général
redis-cli PING                          # → PONG si Redis répond
redis-cli INFO server                   # version, uptime, pid
redis-cli INFO memory                   # mémoire utilisée / pic
redis-cli INFO stats                    # commandes traitées, connexions
redis-cli INFO replication              # rôle master/replica
redis-cli INFO keyspace                 # nombre de clés par base
redis-cli INFO all                      # tout en une fois

# Moniteur en temps réel (toutes les commandes reçues)
redis-cli MONITOR                       # Ctrl+C pour quitter

# Latence
redis-cli --latency                     # latence en ms
redis-cli --latency-history -i 5        # historique toutes les 5 s
```

---

### Exploration des données IPAM

```bash
# Structure globale
redis-cli KEYS "*"                      # toutes les clés (prudence en prod)
redis-cli SCAN 0 COUNT 100              # parcours sans bloquer

# Sites
redis-cli SMEMBERS sites                # liste des IDs de sites
redis-cli SCARD sites                   # nombre de sites
redis-cli HGETALL site:<id>             # détail d'un site

# VLANs
redis-cli SMEMBERS vlans                # liste des IDs de VLANs
redis-cli HGETALL vlan:<id>             # détail d'un VLAN

# IPs
redis-cli SMEMBERS ips                  # tous les IDs d'IPs
redis-cli SCARD ips                     # nombre total d'IPs
redis-cli HGETALL ip:<id>               # détail d'une IP

# Utilisateurs
redis-cli SMEMBERS users                # liste des IDs utilisateurs
redis-cli HGETALL user:<id>             # détail d'un utilisateur
redis-cli HGETALL users:idx:username    # index username → id

# Journaux
redis-cli LLEN logs                     # nombre de logs stockés
redis-cli LRANGE logs 0 9               # 10 derniers logs
redis-cli LRANGE logs 0 -1              # tous les logs

# Demandes en attente
redis-cli SMEMBERS vlan_requests        # demandes VLAN en attente
redis-cli SMEMBERS account_requests     # demandes de compte en attente
```

---

### Diagnostic et réparation des utilisateurs

```bash
# Lister tous les IDs utilisateurs enregistrés
redis-cli SMEMBERS users

# Inspecter un utilisateur par son ID
redis-cli HGETALL user:<id>

# Vérifier l'index username → id
redis-cli HGETALL users:idx:username

# Chercher l'ID d'un utilisateur par son login (exact, sensible à la casse)
redis-cli HGET users:idx:username ADMIN
redis-cli HGET users:idx:username admin

# Boucle de diagnostic — afficher tous les utilisateurs avec leur username
for id in $(redis-cli SMEMBERS users); do
  echo -n "user:$id → "
  redis-cli HGET user:$id username
done

# ── Cas : compte ADMIN stocké en minuscules (username: admin) ──
# Symptôme : connexion avec ADMIN impossible, index retourne (nil)
# redis-cli HGET users:idx:username ADMIN  → (nil)
# redis-cli HGET users:idx:username admin  → <uuid>

# 1. Corriger le champ username dans le hash
redis-cli HSET user:<id> username ADMIN

# 2. Recréer l'entrée dans l'index avec la clé en majuscules
redis-cli HSET users:idx:username ADMIN <id>

# 3. Supprimer l'ancienne entrée en minuscules
redis-cli HDEL users:idx:username admin

# 4. Redémarrer le service
systemctl restart ipam

# Vérification finale
redis-cli HGET users:idx:username ADMIN   # doit retourner le <uuid>
redis-cli HGET user:<id> username         # doit retourner ADMIN
```

> **Note :** Depuis la version v2.1.1, la fonction `ensureDefaultAdmin` détecte et corrige automatiquement ce cas au démarrage du service. Le recours aux commandes manuelles ci-dessus n'est nécessaire que si la v2.1.1 n'est pas encore déployée.

---

### Sauvegarde et restauration

```bash
# --- Sauvegarde ---

# Snapshot RDB manuel (non bloquant)
redis-cli BGSAVE
redis-cli LASTSAVE                      # timestamp du dernier snapshot

# Copier le fichier RDB
cp /var/lib/redis/ipam.rdb /backup/ipam_$(date +%Y-%m-%d_%H%M).rdb

# Export texte de toutes les clés (pour audit)
redis-cli --rdb /backup/ipam_$(date +%Y-%m-%d).rdb

# --- Restauration ---

# Arrêter Redis avant de restaurer
systemctl stop redis

# Remplacer le fichier RDB
cp /backup/ipam_2026-03-17.rdb /var/lib/redis/ipam.rdb
chown redis:redis /var/lib/redis/ipam.rdb

# Redémarrer
systemctl start redis
redis-cli PING

# --- Cron quotidien à 2 h ---
cat > /etc/cron.d/ipam-backup <<'EOF'
0 2 * * * root redis-cli BGSAVE && sleep 5 && cp /var/lib/redis/ipam.rdb /backup/ipam_$(date +\%Y-\%m-\%d).rdb
EOF
```

---

### Maintenance et nettoyage

```bash
# Mémoire
redis-cli MEMORY USAGE logs             # poids de la clé logs en octets
redis-cli MEMORY DOCTOR                 # diagnostic mémoire
redis-cli MEMORY PURGE                  # libérer la mémoire allouée inutilisée

# Défragmentation (Redis 4+)
redis-cli CONFIG SET activedefrag yes
redis-cli MEMORY PURGE

# Taille de la liste de logs
redis-cli LLEN logs

# Tronquer les logs à 1000 entrées (garder les plus récents)
redis-cli LTRIM logs 0 999

# Supprimer une clé spécifique
redis-cli DEL site:<id>

# Vérifier le TTL d'une clé (-1 = pas d'expiration)
redis-cli TTL <clé>

# Rechercher les clés d'un site précis
redis-cli KEYS "site:*"
redis-cli KEYS "vlan:*"
redis-cli KEYS "ip:*"
redis-cli KEYS "user:*"
```

---

### Configuration à chaud

```bash
# Voir la configuration active
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET save
redis-cli CONFIG GET bind
redis-cli CONFIG GET "*"                # toute la config

# Modifier sans redémarrer
redis-cli CONFIG SET maxmemory 512mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Persister la config modifiée dans redis.conf
redis-cli CONFIG REWRITE
```

---

### Commandes d'urgence

```bash
# Forcer une sauvegarde synchrone (bloquant — éviter en prod sous charge)
redis-cli SAVE

# Vérifier si Redis est en train de sauvegarder
redis-cli LASTSAVE
redis-cli INFO persistence | grep rdb_bgsave_in_progress

# Fermer toutes les connexions clientes (sauf redis-cli actif)
redis-cli CLIENT LIST
redis-cli CLIENT KILL ID <id>

# Recharger la configuration
redis-cli CONFIG REWRITE
systemctl reload redis

# ⚠ ATTENTION — commandes destructives (désactivées en prod par redis.conf)
# redis-cli FLUSHDB   → vide la base courante
# redis-cli FLUSHALL  → vide TOUTES les bases
# Ces commandes sont désactivées dans deploy/redis.conf (rename-command)
```

---

## Sauvegarde

```bash
# Snapshot manuel
redis-cli BGSAVE
cp /var/lib/redis/ipam.rdb /backup/ipam_$(date +%Y-%m-%d).rdb

# Cron quotidien à 2 h
echo "0 2 * * * root redis-cli BGSAVE && sleep 2 && cp /var/lib/redis/ipam.rdb /backup/ipam_\$(date +\%Y-\%m-\%d).rdb" \
  > /etc/cron.d/ipam-backup
```

---

## Maintenance

```bash
# Statut
systemctl status ipam redis httpd

# Logs
journalctl -u ipam -f
journalctl -u redis -f
tail -f /var/log/httpd/ipam_error.log

# Redémarrage
systemctl restart ipam
systemctl reload  httpd
systemctl restart redis

# Inspecter Redis
redis-cli INFO memory
redis-cli LLEN logs
redis-cli KEYS "site:*"
redis-cli SCARD sites
```

---

## Dépannage

| Symptôme | Cause | Solution |
|---|---|---|
| 502 Bad Gateway | Node.js arrêté | `systemctl restart ipam` |
| Erreur Redis ECONNREFUSED | Redis arrêté | `systemctl restart redis` |
| 401 Unauthorized | Token expiré | Se reconnecter |
| 403 sur `/api/*` | Apache bloque la route | Vérifier `LocationMatch` dans `ipam.conf` |
| Sites vides après déploiement | Données non importées | Lancer `import_redis.py` |
| Site inaccessible depuis l'extérieur | Pare-feu | `firewall-cmd --list-all` — ouvrir 80 et 443 |
| SELinux bloque le proxy | httpd sans accès réseau | `setsebool -P httpd_can_network_connect 1` |
| Avertissement certificat | Certificat auto-signé | Cliquer "Avancé → Accepter" |
| Déconnexion automatique | Timeout 20 min | Normal — se reconnecter |
| IPs non générées à l'ajout VLAN | CIDR manquant | Saisir le réseau au format `192.168.1.0/24` |
| Config → "Service non autorisé" | URL modifiée manuellement | Normal — whitelist stricte côté serveur |
| Config → Logs vides | sudo non configuré | Exécuter `bash deploy/setup-config-permissions.sh` |
| Config → Téléchargement RDB échoue | Permissions insuffisantes | `usermod -aG redis ipam && chmod 664 /var/lib/redis/ipam.rdb` puis `systemctl restart ipam` |
| Config → Restauration échoue | ipam ne peut pas écrire le RDB | Même solution que ci-dessus |
| Config → Sync échoue | Instance Redis cible injoignable | Vérifier l'hôte/port et utiliser d'abord "Tester" |

---

## Changelog

### v2.2.0 — 2026-03-25

#### Page Configuration système (super admin)

Nouvelle page `/config.html` accessible uniquement au compte `ADMIN`, protégée côté serveur par un triple middleware (`requireAuth + requireAdmin + requireSuperAdmin`).

**Onglet Services**
- Statut en direct (`systemctl status`) pour les services `ipam`, `httpd`, `redis`
- Redémarrage et rechargement (httpd reload) avec confirmation
- Logs des 100 dernières lignes via `journalctl` (panneau dépliable par service)
- Rafraîchissement automatique toutes les 10 s

**Onglet Configuration Redis**
- Lecture des paramètres courants via `CONFIG_IPAM_ADMIN GET`
- Modification en direct via `CONFIG_IPAM_ADMIN SET` (whitelist de 6 paramètres)
- Paramètre `bind` affiché en lecture avec avertissement visuel

**Onglet Sauvegarde / Restauration**
- Déclenchement BGSAVE, affichage de la date et taille du dernier snapshot
- Téléchargement du fichier RDB avec authentification Bearer (fetch + Blob)
- Restauration depuis un fichier `.rdb` avec validation des magic bytes et redémarrage Redis automatique

**Onglet Bases de données supplémentaires**
- Ajout / suppression de connexions Redis (stockées dans Redis sous `config:databases`)
- Test PING avec latence mesurée
- Synchronisation complète (SCAN + DUMP/RESTORE) vers une instance cible

**Infrastructure**
- `server/routes/config.mjs` — 12 nouvelles routes API sous `/api/config/*`
- `server/middleware/auth.mjs` — ajout de `requireSuperAdmin`
- `deploy/setup-config-permissions.sh` — script dédié aux prérequis serveur
- `deploy/deploy.sh` — intègre automatiquement les étapes sudo + groupe redis + permissions RDB

#### Structure mise à jour
```
client/
├── config.html              ← NOUVEAU — Page Configuration système
└── js/
    └── config.js            ← NOUVEAU — Logique de la page
server/
├── middleware/auth.mjs      ← Ajout requireSuperAdmin
└── routes/
    └── config.mjs           ← NOUVEAU — 12 routes /api/config/*
deploy/
└── setup-config-permissions.sh  ← NOUVEAU — Prérequis sudo + RDB
```

---

### v2.1.0 — 2026-03-16

#### Demandes de création de compte
- Nouveau formulaire "Créer un compte" sur la page de connexion
- L'utilisateur saisit son nom complet, son identifiant IDRH (`PXxx999`) et son mot de passe
- La demande est transmise à l'administrateur sans créer de compte immédiatement
- Toast de confirmation auto-dismiss 5 secondes : *"Votre demande a été transmise à un administrateur"*
- Nouvel onglet **"Demandes de compte"** dans le panneau d'administration avec badge de comptage
- L'admin peut **Approuver** (crée le compte avec le rôle Utilisateur) ou **Refuser** (supprime la demande)
- Toutes les approbations/refus sont tracés dans le journal d'activité

#### Rôle Lecteur (viewer)
- Le rôle `viewer` a désormais la même vue que l'utilisateur standard (sidebar, VLANs, table IPs paginée)
- Toutes les actions sont masquées : Réserver, Libérer, Changer statut, Renommer hostname, Demander un VLAN, Import Excel
- Le viewer a accès à **Export Excel** depuis la barre latérale
- Le lien Archive est masqué pour les viewers
- Redirection automatique vers `site.html` depuis `dashboard.html`

#### Popup de confirmation centré
- Remplacement de **tous** les `confirm()` natifs du navigateur par un vrai popup centré
- Style sombre cohérent avec l'interface, animation d'apparition fluide
- Bouton **Confirmer** (bleu) ou **rouge** pour les actions destructives
- Bouton **Annuler** + clic en dehors du modal pour fermer
- Concerne : déconnexion, suppression utilisateur, suppression site, suppression VLAN, effacement journaux, validation/refus de demande VLAN, approbation/refus de demande de compte, changement de statut IP

#### Corrections
- Fix : réinitialisation MDP admin — le champ envoyé était `password` au lieu de `newPassword` → retournait systématiquement une erreur 400
- Fix : rôle viewer — la variable `user` était déclarée dans `DOMContentLoaded` et inaccessible aux fonctions du module → la table IP ne s'affichait jamais pour les viewers

#### Structure mise à jour
```
server/routes/
└── account_requests.mjs   ← NOUVEAU — CRUD demandes de compte + approbation
client/js/
└── api.js                 ← Ajout showConfirm() — popup Promise-based
```

---

## Licence

MIT License — Copyright (c) 2025 **Wilfrid Peyrius**

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
