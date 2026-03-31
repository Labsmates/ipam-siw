# IPAM SIW — Troubleshooting

---

## Apache / HTTPS

### Warning : `Could not reliably determine the server's fully qualified domain name`

Avertissement cosmétique — Apache fonctionne normalement. Pour le supprimer :

```bash
echo "ServerName ipam-siw.intra.laposte.fr" >> /etc/httpd/conf/httpd.conf
httpd -t && systemctl reload httpd
```

---

### Port 443 inactif — Apache n'écoute que sur le port 80

**Cause :** `ssl.conf` désactivé → `Listen 443 https` et `SSLSessionCache` ont disparu.

```bash
# Recréer les directives globales SSL manquantes
cat > /etc/httpd/conf.d/ssl-global.conf << 'EOF'
Listen 443 https
SSLSessionCache shmcb:/run/httpd/sslcache(512000)
EOF

httpd -t && systemctl reload httpd
ss -tlnp | grep httpd   # vérifier que 443 apparaît
```

---

### `NET::ERR_CERT_INVALID` — Certificat rejeté par le navigateur

#### Étape 1 — Vérifier l'Extended Key Usage

```bash
openssl x509 -noout -ext extendedKeyUsage -in /var/www/ipam/data/ipam.crt
```

- `TLS Web Server Authentication` → OK
- `TLS Web Client Authentication` uniquement → **certificat mal émis**, voir ci-dessous

#### Étape 2 — Vérifier la chaîne de certificats

```bash
# Ordre attendu : serveur → intermédiaire → racine
openssl crl2pkcs7 -nocrl -certfile /var/www/ipam/data/ipam.crt | \
  openssl pkcs7 -print_certs -noout | grep -E "subject|issuer"

# Nombre de certificats dans la fullchain (doit être ≥ 2)
grep -c "BEGIN CERTIFICATE" /var/www/ipam/data/ipam.crt
```

#### Étape 3 — Tester la connexion SSL

```bash
openssl s_client -connect ipam-siw.intra.laposte.fr:443 -showcerts 2>/dev/null | head -40
```

---

### Certificat émis avec `clientAuth` uniquement (pas `serverAuth`)

**Symptôme :** `NET::ERR_CERT_INVALID` malgré une CA connue et une fullchain correcte.

**Diagnostic :**
```bash
openssl x509 -noout -ext extendedKeyUsage -in /var/www/ipam/data/ipam.crt
# → TLS Web Client Authentication   ← problème : serverAuth manquant
```

**Solution :** redemander un certificat au PKI avec `serverAuth`.

> ⚠️ La réutilisation de clé privée peut être interdite par la PKI — générer une nouvelle clé.

```bash
# 1. Générer une nouvelle clé privée
openssl genrsa -out /var/www/ipam/data/ipam.key 2048
chmod 600 /var/www/ipam/data/ipam.key
chown ipam:ipam /var/www/ipam/data/ipam.key

# 2. Créer le fichier de config CSR avec le bon EKU
cat > /tmp/ipam_csr.cnf << 'EOF'
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
O  = DSIBA
OU = LA BANQUE POSTALE SA
CN = ipam-siw.intra.laposte.fr

[req_ext]
subjectAltName   = @alt_names
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = ipam-siw.intra.laposte.fr
DNS.2 = ipam-siw
IP.1  = 218.16.185.50
EOF

# 3. Générer le CSR
openssl req -new \
  -key    /var/www/ipam/data/ipam.key \
  -out    /tmp/ipam_new.csr \
  -config /tmp/ipam_csr.cnf

# 4. Vérifier le CSR
openssl req -text -noout -in /tmp/ipam_new.csr | grep -A3 "Extended Key"

# 5. Afficher le CSR à transmettre au PKI
cat /tmp/ipam_new.csr
```

Transmettre `/tmp/ipam_new.csr` au PKI en précisant **`TLS Web Server Authentication`** (`serverAuth`).

Une fois le certificat reçu (`.cer`) :

```bash
# Copier la fullchain
cp /chemin/vers/ipam_fullchain.cer /var/www/ipam/data/ipam.crt
chown ipam:ipam /var/www/ipam/data/ipam.crt
chmod 644 /var/www/ipam/data/ipam.crt

# Vérifier que clé et certificat correspondent
openssl rsa  -noout -modulus -in /var/www/ipam/data/ipam.key | openssl md5
openssl x509 -noout -modulus -in /var/www/ipam/data/ipam.crt | openssl md5
# Les deux MD5 doivent être identiques

httpd -t && systemctl reload httpd
```

---

### ServerName configuré avec une IP — connexions par IP interdites

```bash
# Remplacer l'IP par le FQDN dans ipam.conf
sed -i 's/ServerName 218\.16\.185\.50/ServerName ipam-siw.intra.laposte.fr/g' \
  /etc/httpd/conf.d/ipam.conf

httpd -t && systemctl reload httpd
```

---

## Node.js / IPAM

### Le service IPAM ne redémarre pas après `systemctl restart ipam`

Vérifier que `Restart=always` est bien dans le fichier service :

```bash
grep Restart /etc/systemd/system/ipam.service
# → Restart=always

# Si non, appliquer le fichier corrigé
cp /var/www/ipam/deploy/ipam.service /etc/systemd/system/ipam.service
systemctl daemon-reload
systemctl restart ipam
```

---

### Redémarrage du service IPAM → page "Service Unavailable"

**Cause :** pendant les ~10s de redémarrage, Apache retourne 503.
**Solution :** l'interface affiche automatiquement une overlay de reconnexion qui recharge la page dès que IPAM répond.

Si l'overlay ne disparaît pas → le service ne redémarre pas (voir ci-dessus).

---

## Redis

### Aucune donnée après restauration RDB

Voir [RESTAURATION.md](RESTAURATION.md) — section **Troubleshooting**.

---

## tcpdump

### `Aucune interface détectée`

**Cause :** `/usr/sbin/ip` absent du PATH systemd sur RHEL/Rocky.
**Solution :** corrigé automatiquement depuis v2.5.0 — le serveur essaie plusieurs chemins.

Si le problème persiste après `git pull && systemctl restart ipam` :

```bash
which ip
# ex: /usr/sbin/ip → vérifier que le binaire existe
ls /usr/sbin/ip /sbin/ip /usr/bin/ip /bin/ip 2>/dev/null
```
