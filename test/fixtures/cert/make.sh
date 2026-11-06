#!/bin/sh
# Regenerates the fixtures of test/cert.test.ts and test/certSecrets.test.ts next to this script.
#
# Every key here is a throwaway made for these tests: it protects nothing and was never used anywhere
# else. The passphrase of the encrypted ones is "previewix". A scanner that reports them as leaked
# secrets is wrong.
#
# Needs OpenSSL 3.4 or later (for -not_before and -not_after) and ssh-keygen. The keys are random, so a
# new run gives new files. The tests don't mind: what follows from a key (fingerprints, key identifiers)
# they compute themselves, and everything else (names, serial numbers, dates, extensions) is fixed here
# and repeated in cert.test.ts as constants. Change one and you change the other.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

cat > x.cnf <<X
[req]
distinguished_name = dn
prompt = no
utf8 = yes
string_mask = utf8only
[dn]
CN = replaced by -subj
[root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = none
[inter]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,digitalSignature,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.example.test/root.crl
authorityInfoAccess = OCSP;URI:http://ocsp.example.test,caIssuers;URI:http://ca.example.test/root.crt
certificatePolicies = 2.23.140.1.2.1,1.3.6.1.4.1.99999.1
nameConstraints = permitted;DNS:.example.test,excluded;IP:10.0.0.0/255.0.0.0
[leaf]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = DNS:example.test,DNS:*.example.test,DNS:xn--mnchen-3ya.example.test,IP:192.0.2.10,IP:2001:db8::1,IP:::1,IP:2001:db8:0:1:2:3:4:5,email:admin@example.test,URI:https://example.test/id,RID:1.2.3.4,otherName:1.3.6.1.4.1.311.20.2.3;UTF8:user@example.test,dirName:dir
tlsfeature = status_request
1.3.6.1.4.1.99999.5 = ASN1:UTF8String:custom value
[dir]
CN = dir name
O = Dir Org
[plain]
basicConstraints = CA:FALSE
subjectKeyIdentifier = hash
authorityKeyIdentifier = none
[impostor]
basicConstraints = critical,CA:TRUE
subjectKeyIdentifier = none
authorityKeyIdentifier = none
[impostor_ski]
basicConstraints = critical,CA:TRUE
subjectKeyIdentifier = hash
authorityKeyIdentifier = none
X

# ---- Keys that are fixtures ----------------------------------------------------
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rsa.key 2>/dev/null   # PKCS #8
openssl rsa -in rsa.key -traditional -out rsa.pkcs1.key 2>/dev/null                    # PKCS #1
openssl pkcs8 -topk8 -in rsa.key -passout pass:previewix -v2 aes-256-cbc -out rsa.enc8.key
openssl rsa -in rsa.key -traditional -aes256 -passout pass:previewix -out rsa.legacy.key 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out ec.key                            # SEC 1
openssl pkcs8 -topk8 -nocrypt -in ec.key -out ec.pkcs8.key
openssl genpkey -algorithm ed25519 -out ed.key
ssh-keygen -q -t ed25519 -N "" -C previewix-test -f ssh-ed
ssh-keygen -q -t ed25519 -N "previewix" -C previewix-test -f ssh-ed-enc
ssh-keygen -q -t rsa -b 2048 -N "" -C previewix-test -f ssh-rsa

# ---- Keys that sign and are thrown away ----------------------------------------
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out root.key 2>/dev/null
openssl ecparam -name secp384r1 -genkey -noout -out inter.key
openssl ecparam -name secp256k1 -genkey -noout -out k1.key
openssl ecparam -name prime256v1 -genkey -noout -out other.key
openssl genpkey -algorithm rsa-pss -pkeyopt rsa_keygen_bits:2048 -out pss.key 2>/dev/null

INTER='/C=US/O=Previewix Test/OU=Issuing, Dept "A"/CN=Previewix Test Intermediate'

# ---- A root, an intermediate and a leaf ----------------------------------------
openssl req -x509 -new -config x.cnf -extensions root -key root.key -sha256 -set_serial 1 \
  -not_before 20200101000000Z -not_after 20600101000000Z -subj "/C=US/O=Previewix Test/CN=Previewix Test Root" -out root.crt
openssl req -new -config x.cnf -key inter.key -subj "$INTER" -out inter.csr
openssl x509 -req -in inter.csr -CA root.crt -CAkey root.key -set_serial 0x1000 -sha384 \
  -not_before 20210203040506Z -not_after 20410203040506Z -extfile x.cnf -extensions inter -out inter.crt 2>/dev/null
openssl req -new -config x.cnf -key rsa.key -utf8 \
  -subj "/C=DE/ST=Bayern/L=München/O=Beispiel GmbH/CN=example.test/emailAddress=admin@example.test" -out leaf.csr
openssl x509 -req -in leaf.csr -CA inter.crt -CAkey inter.key -set_serial 0xF0E1D2C3B4A5968778695A4B3C2D1E0F00112233 -sha256 \
  -not_before 20250601120000Z -not_after 20250830120000Z -extfile x.cnf -extensions leaf -out leaf.crt 2>/dev/null

# ---- Certificates that stand alone ---------------------------------------------
# Ed25519, self-signed and not a CA; the same key again as a version 1 certificate, which has no extensions
# and begins in the last second of 1999 (a two-digit year of the other century).
openssl req -x509 -new -config x.cnf -extensions plain -key ed.key -set_serial 2 \
  -not_before 20240101000000Z -not_after 20240131000000Z -subj "/CN=Previewix Test Ed25519" -out ed.crt
openssl req -x509 -x509v1 -new -config x.cnf -key ed.key -set_serial 3 \
  -not_before 19991231235959Z -not_after 20240111000000Z -subj "/CN=Previewix Test V1" -out v1.crt
# RSA-PSS, key and signature.
openssl req -x509 -new -config x.cnf -extensions plain -key pss.key -set_serial 4 -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:32 \
  -not_before 20240101000000Z -not_after 20250101000000Z -subj "/CN=Previewix Test PSS" -out pss.crt
# secp256k1, which VS Code's crypto can't check: a CA and a certificate it issued.
openssl req -x509 -new -config x.cnf -extensions root -key k1.key -set_serial 5 \
  -not_before 20240101000000Z -not_after 20340101000000Z -subj "/CN=Previewix Test K1 CA" -out k1-ca.crt
openssl req -new -config x.cnf -key ed.key -subj "/CN=k1.example.test" -out k1-leaf.csr
openssl x509 -req -in k1-leaf.csr -CA k1-ca.crt -CAkey k1.key -set_serial 6 \
  -not_before 20240101000000Z -not_after 20250101000000Z -extfile x.cnf -extensions plain -out k1-leaf.crt 2>/dev/null
# Two that carry the name of the intermediate and another key: one without a key identifier, one with its own.
openssl req -x509 -new -config x.cnf -extensions impostor -key other.key -set_serial 7 \
  -not_before 20210203040506Z -not_after 20410203040506Z -subj "$INTER" -out impostor.crt
openssl req -x509 -new -config x.cnf -extensions impostor_ski -key other.key -set_serial 8 \
  -not_before 20210203040506Z -not_after 20410203040506Z -subj "$INTER" -out impostor-ski.crt

# ---- PKCS #7, a request, a revocation list -------------------------------------
cat leaf.crt inter.crt root.crt > chain.pem
openssl crl2pkcs7 -nocrl -certfile chain.pem -outform der -out chain.p7b
cat > req.cnf <<X
[req]
distinguished_name = dn
req_extensions = v3
attributes = attrs
prompt = no
[dn]
C = US
O = Requester Inc
CN = request.example.test
[attrs]
challengePassword = TopSecretChallenge
unstructuredName = An unstructured name
[v3]
subjectAltName = DNS:request.example.test,DNS:www.request.example.test,IP:198.51.100.7
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
X
openssl req -new -key ec.key -config req.cnf -out request.csr
# The database of the CA is written by hand, so that the date of the revocation is not today's.
mkdir ca && echo 01 > ca/crlnumber
printf 'R\t250830120000Z\t250615000000Z\tF0E1D2C3B4A5968778695A4B3C2D1E0F00112233\tunknown\t/CN=example.test\n' > ca/index.txt
cat > ca.cnf <<X
[ca]
default_ca = x
[x]
database = ca/index.txt
crlnumber = ca/crlnumber
default_md = sha256
X
openssl ca -config ca.cnf -gencrl -keyfile inter.key -cert inter.crt -crl_lastupdate 20250701000000Z -crl_nextupdate 20250731000000Z -out inter.crl 2>/dev/null

cp root.crt inter.crt leaf.crt ed.crt v1.crt pss.crt k1-ca.crt k1-leaf.crt impostor.crt impostor-ski.crt chain.p7b request.csr inter.crl \
  rsa.key rsa.pkcs1.key rsa.enc8.key rsa.legacy.key ec.key ec.pkcs8.key ed.key \
  ssh-ed ssh-ed.pub ssh-ed-enc ssh-ed-enc.pub ssh-rsa ssh-rsa.pub "$here/"
