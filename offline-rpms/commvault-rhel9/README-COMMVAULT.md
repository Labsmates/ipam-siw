# Commvault Agent — RHEL 9 x86_64

## Pourquoi le .tar.gz n'est pas inclus ici

Le package Commvault est lié à votre licence et à votre infrastructure CommCell.
Il ne peut pas être téléchargé depuis un dépôt public.

## Comment récupérer le .tar.gz

### Option 1 — WebConsole CommCell (recommandée)
```
https://<votre-commcell>/webconsole
→ Software Store (ou "Download Center")
→ Unix/Linux → Red Hat Enterprise Linux 9 → x86_64
→ Télécharger → unix_pkg.tar.gz
```

### Option 2 — URL directe CommCell
```bash
curl -k -O "https://<votre-commcell>/downloads/UnixLinux/unix_pkg.tar.gz"
```

### Option 3 — Depuis un serveur déjà installé
```bash
scp root@serveur-existant:/opt/commvault/Base/Packages/*.tar.gz /tmp/
```

## Une fois le .tar.gz récupéré

Placez-le dans ce dossier :
```
offline-rpms/commvault-rhel9/unix_pkg.tar.gz
```

Puis suivez le guide d'installation dans HA.md (Étape 9).
