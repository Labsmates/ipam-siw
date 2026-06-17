# Protection serveur — Anti-scan de ports

Mesures défensives pour durcir le serveur de production contre les scans (nmap, masscan, etc.).

---

## 1. Vérifier les ports exposés

```bash
firewall-cmd --list-all
ss -tlnp
```

Ports légitimes attendus : **80** (HTTP), **443** (HTTPS), **22** (SSH).
Redis (:6379) et Node.js (:3000) doivent être inaccessibles depuis l'extérieur.

---

## 2. Firewall strict (firewalld)

```bash
# Supprimer tout service non nécessaire
firewall-cmd --permanent --remove-service=cockpit 2>/dev/null
firewall-cmd --permanent --remove-service=dhcpv6-client 2>/dev/null

# Ne garder que HTTP, HTTPS, SSH
firewall-cmd --permanent --set-default-zone=drop
firewall-cmd --permanent --zone=drop --add-service=http
firewall-cmd --permanent --zone=drop --add-service=https
firewall-cmd --permanent --zone=drop --add-service=ssh

firewall-cmd --reload
firewall-cmd --list-all
```

---

## 3. Limiter les scans rapides (iptables / nftables)

Bloque les IPs qui touchent plus de 15 ports en 10 secondes.

```bash
# Installer iptables-services si absent
dnf install -y iptables-services

# Règles anti-scan
iptables -A INPUT -m state --state NEW -m recent --set --name PORTSCAN
iptables -A INPUT -m state --state NEW -m recent --update --seconds 10 --hitcount 15 --name PORTSCAN -j DROP

# Persister les règles
service iptables save
```

---

## 4. fail2ban — Détection et ban automatique

```bash
# Installation
dnf install -y fail2ban

# Configuration /etc/fail2ban/jail.local
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s

[portscan]
enabled  = true
filter   = portscan
logpath  = /var/log/messages
action   = iptables-allports[name=portscan]
maxretry = 1
bantime  = 86400
EOF

# Filtre portscan /etc/fail2ban/filter.d/portscan.conf
cat > /etc/fail2ban/filter.d/portscan.conf <<'EOF'
[Definition]
failregex = kernel.*IN=.*OUT=.*SRC=<HOST>.*DPT=
ignoreregex =
EOF

systemctl enable --now fail2ban
systemctl status fail2ban

# Voir les IPs bannies
fail2ban-client status portscan
```

---

## 5. Masquer les bannières de service

### Apache
```bash
# Déjà configuré via deploy.sh (ServerTokens Prod + ServerSignature Off)
# Vérifier :
grep -i "ServerTokens\|ServerSignature" /etc/httpd/conf/httpd.conf
```

### Node.js — supprimer X-Powered-By
Dans `server/index.mjs`, s'assurer que la ligne suivante est présente :
```javascript
app.disable('x-powered-by');
```

### SSH
```bash
# /etc/ssh/sshd_config
echo "DebianBanner no" >> /etc/ssh/sshd_config
echo "Banner none"     >> /etc/ssh/sshd_config
systemctl restart sshd
```

---

## 6. Changer le port SSH (recommandé)

```bash
# /etc/ssh/sshd_config — changer Port 22 en ex: 2222
sed -i 's/^#Port 22/Port 2222/' /etc/ssh/sshd_config

# Ouvrir le nouveau port dans firewalld
firewall-cmd --permanent --zone=drop --add-port=2222/tcp
firewall-cmd --permanent --zone=drop --remove-service=ssh
firewall-cmd --reload

# SELinux : autoriser le nouveau port
semanage port -a -t ssh_port_t -p tcp 2222

systemctl restart sshd
# Vérifier la connexion sur le nouveau port AVANT de fermer la session courante
```

> **Attention** : se connecter sur le nouveau port avant de fermer la session active.

---

## 7. Vérifications finales

```bash
# Tester depuis l'extérieur
nmap -sV 172.18.23.56

# Voir les connexions actives
ss -tlnp

# Logs fail2ban en temps réel
tail -f /var/log/fail2ban.log

# Bannir manuellement une IP suspecte
fail2ban-client set sshd banip <IP>

# Débannir une IP
fail2ban-client set sshd unbanip <IP>
```

---

## Résumé des protections

| Mesure | Effet |
|---|---|
| Firewall strict | Seuls 80/443/SSH exposés |
| iptables rate-limit | Scan rapide bloqué après 15 hits/10s |
| fail2ban portscan | Ban 24h automatique |
| Bannières masquées | OS et versions non visibles |
| Port SSH custom | Élimine 90% des scans automatisés |
