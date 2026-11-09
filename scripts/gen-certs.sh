#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
CA_DAYS="${CA_DAYS:-365}"
LEAF_DAYS="${LEAF_DAYS:-397}"
RENEW_CA="${RENEW_CA:-0}"
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

mark_ca_replacement() {
  : >.ca-renewal-pending
  if [ -f ca.crt ]; then
    local old_hash
    old_hash="$(openssl x509 -in ca.crt -noout -fingerprint -sha1 2>/dev/null \
      | sed 's/^.*=//; s/://g' || true)"
    if [ -n "$old_hash" ]; then
      if ! cp -p ca.crt ".ca-renewal-old-$old_hash.crt"; then
        printf 'could not preserve the replaced CA certificate; refusing to continue\n' >&2
        exit 1
      fi
      touch .ca-renewal-old-hash
      grep -qx "$old_hash" .ca-renewal-old-hash 2>/dev/null \
        || printf '%s\n' "$old_hash" >>.ca-renewal-old-hash
    fi
  fi
}

if [ "$RENEW_CA" = "1" ]; then
  mark_ca_replacement
  rm -f ca.crt ca.srl
fi
if [ -f ca.crt ] && ! openssl x509 -in ca.crt -noout >/dev/null 2>&1; then
  mark_ca_replacement
  rm -f ca.crt
fi
if [ -f ca.key ] && ! openssl rsa -in ca.key -check -noout >/dev/null 2>&1; then
  rm -f ca.key
fi
if [ -f ca.crt ] && ! openssl x509 -in ca.crt -noout -text 2>/dev/null \
  | sed -n '/Basic Constraints/,+2p' | grep -q 'CA:TRUE'; then
  mark_ca_replacement
  rm -f ca.crt
fi
if [ -f ca.crt ] && { [ "$(openssl x509 -in ca.crt -noout -subject -nameopt RFC2253 2>/dev/null | sed 's/^subject= *//' || true)" != "$(openssl x509 -in ca.crt -noout -issuer -nameopt RFC2253 2>/dev/null | sed 's/^issuer= *//' || true)" ] \
  || ! openssl verify -check_ss_sig -CAfile ca.crt ca.crt >/dev/null 2>&1; }; then
  mark_ca_replacement
  rm -f ca.crt
fi
if [ -f ca.crt ] && [ ! -f ca.key ]; then
  mark_ca_replacement
  rm -f ca.crt
fi
if [ -f ca.crt ] && [ -f ca.key ]; then
  crt_pub="$(openssl x509 -in ca.crt -noout -pubkey 2>/dev/null || true)"
  key_pub="$(openssl pkey -in ca.key -pubout 2>/dev/null || true)"
  if [ -z "$crt_pub" ] || [ "$crt_pub" != "$key_pub" ]; then
    mark_ca_replacement
    rm -f ca.crt ca.key ca.srl
  fi
fi

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
  : >.ca-renewal-pending
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
DNS.3 = api.elevenlabs.io
DNS.4 = localhost
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
openssl x509 -in leaf.crt -noout -subject -issuer
openssl x509 -in leaf.crt -noout -text | sed -n '/X509v3 Subject Alternative Name/,+2p'
