# IPAM SIW v2 — Guide de déploiement Rocky Linux 10

Application web multi-utilisateurs de gestion des adresses IP.
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
│   ├── admin.html          ← Administration
│   └── js/
│       ├── api.js          ← Fetch wrapper, JWT, toast, timer inactivité
│       ├── auth.js         ← Login (redirige vers site.html)
│       ├── dashboard.js    ← Grille des sites
│       ├── site.js         ← Sidebar, table IPs, modals
│       └── admin.js        ← Utilisateurs, sites, journaux, MDP
├── server/
│   ├── index.mjs           ← Serveur Express
│   ├── redis.mjs           ← Couche d'accès Redis
│   ├── utils.mjs           ← sha256, uid, now
│   ├── middleware/
│   │   └── auth.mjs        ← Vérification JWT
│   └── routes/
│       ├── auth.mjs        ← Login, utilisateurs, /me/password
│       ├── sites.mjs       ← CRUD sites, ajout VLAN (IPs auto), import
│       ├── vlans.mjs       ← CRUD VLANs
│       ├── ips.mjs         ← Réservation / libération
│       └── logs.mjs        ← Journal d'activité
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
│   ├── deploy.sh           ← Script de déploiement automatisé
│   ├── ipam.conf           ← Apache Virtual Host
│   ├── ipam.service        ← Service systemd Node.js
│   └── redis.conf          ← Configuration Redis production
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

```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/pki/tls/private/ipam.key \
  -out    /etc/pki/tls/certs/ipam.crt \
  -subj   "/C=FR/ST=France/L=Paris/O=SIW/CN=218.16.185.50" \
  -addext "subjectAltName=IP:218.16.185.50"
chmod 600 /etc/pki/tls/private/ipam.key
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

| Page | URL | Description |
|---|---|---|
| Connexion | `/` | Login JWT, redirection automatique si déjà connecté |
| Sites | `/site.html` | Sidebar avec tous les sites, état d'accueil si aucun site sélectionné |
| Détail site | `/site.html?id=N` | VLANs, table IPs paginée, réservation/libération |
| Dashboard | `/dashboard.html` | Grille des sites avec stats (libres / occupées / total) |
| Administration | `/admin.html` | Gestion utilisateurs, sites, journaux, changement MDP |

### Gestion des IPs

| Action | Qui | Description |
|---|---|---|
| Réserver | Tous | Passe une IP `Libre` → `Réservée` |
| Libérer | Tous | Passe une IP `Utilisé` ou `Réservée` → `Libre` |
| Ajouter un VLAN | Admin | Formulaire CIDR → génère automatiquement toutes les IPs hôtes |
| Import Excel | Admin | Fichier .xlsx colonne A = IP → marque les IPs correspondantes `Réservée` |

### Statuts IP

| Statut | Couleur | Description |
|---|---|---|
| `Libre` | Vert | IP disponible |
| `Utilisé` | Rouge | IP en service (hostname présent) |
| `Réservée` | Orange | IP réservée mais non déployée |

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

### Frontend

| Protection | Détail |
|---|---|
| Timeout inactivité | Déconnexion automatique après 20 minutes |
| Onglet inactif | Déconnexion si masqué > 20 minutes |
| sessionStorage | Token effacé à la fermeture du navigateur |

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

---

## Changelog

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

MIT License — Copyright (c) 2025 **Peyrius N KOUNGA TCHIKAYA**

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
