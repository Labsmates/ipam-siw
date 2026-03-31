# Générer une nouvelle clé privée
openssl genrsa -out /var/www/ipam/data/ipam.key 2048
chmod 600 /var/www/ipam/data/ipam.key
chown ipam:ipam /var/www/ipam/data/ipam.key

# Générer le CSR avec la nouvelle clé
openssl req -new \
  -key  /var/www/ipam/data/ipam.key \
  -out  /tmp/ipam_new.csr \
  -config /tmp/ipam_csr.cnf

# Vérifier le CSR
openssl req -text -noout -in /tmp/ipam_new.csr | grep -A3 "Extended Key"

# Afficher le CSR à transmettre au PKI
cat /tmp/ipam_new.csr
Une fois que le PKI te renvoie le nouveau .cer, copie-le dans /var/www/ipam/data/ipam.crt (avec la fullchain) et systemctl reload httpd.
