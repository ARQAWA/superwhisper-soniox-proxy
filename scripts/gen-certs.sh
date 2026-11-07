#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
CA_DAYS="${CA_DAYS:-365}"
LEAF_DAYS="${LEAF_DAYS:-397}"
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 4096
  chmod 600 ca.key
fi

cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = SuperWhisper Soniox Local CA
O = Local Development
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
CNF

if [ ! -f ca.crt ]; then
  openssl req -x509 -new -key ca.key -sha256 -days "$CA_DAYS" -out ca.crt -config ca.cnf
  chmod 644 ca.crt
fi

cat > leaf.cnf <<'CNF'
[req]
distinguished_name = dn
req_extensions = v3_req
prompt = no
[dn]
CN = api.deepgram.com
O = Local Development
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = api.deepgram.com
DNS.2 = api.superwhisper.com
DNS.3 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
CNF

if [ ! -f leaf.key ]; then
  openssl genrsa -out leaf.key 2048
  chmod 600 leaf.key
fi

openssl req -new -key leaf.key -out leaf.csr -config leaf.cnf
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out leaf.crt -days "$LEAF_DAYS" -sha256 -extfile leaf.cnf -extensions v3_req
rm -f leaf.csr
chmod 644 leaf.crt
openssl x509 -in leaf.crt -noout -subject -issuer -ext subjectAltName
