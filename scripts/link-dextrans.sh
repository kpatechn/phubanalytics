#!/usr/bin/env bash
# Creates (or rotates) the read-only dextrans role and links dexl to it.
# Generates a new random password, sends dextrans only its SCRAM verifier, stores
# the password only in dexl's user mapping, and prints no secret.
#
# Usage: scripts/link-dextrans.sh [service]        (default: graton-dev, from ~/.pg_service.conf)
# Overrides for other setups: DEXL_CONN, DEXTRANS_CONN, DEXTRANS_HOST, DEXTRANS_PORT, DEXTRANS_DBNAME.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${1:-graton-dev}"
DEXL_CONN="${DEXL_CONN:-service=$SERVICE dbname=dexl}"
DEXTRANS_CONN="${DEXTRANS_CONN:-service=$SERVICE dbname=dextrans}"

if [[ -z "${DEXTRANS_HOST:-}" ]]; then
    read -r DEXTRANS_HOST DEXTRANS_PORT < <(python3 -I - "$SERVICE" <<'PY'
import configparser, os, sys
c = configparser.ConfigParser(); c.read(os.path.expanduser("~/.pg_service.conf"))
s = c[sys.argv[1]]
print(s["host"], s.get("port", "5432"))
PY
)
fi
export DEXTRANS_HOST DEXTRANS_PORT
export DEXTRANS_DBNAME="${DEXTRANS_DBNAME:-dextrans}"

DEXTRANS_READER_PASSWORD="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(32))')"
DEXTRANS_READER_VERIFIER="$(printf '%s' "$DEXTRANS_READER_PASSWORD" | python3 -I -c '
import base64, hashlib, hmac, os, sys
password = sys.stdin.read().encode()
salt, rounds = os.urandom(16), 4096
salted = hashlib.pbkdf2_hmac("sha256", password, salt, rounds)
client = hmac.new(salted, b"Client Key", "sha256").digest()
server = hmac.new(salted, b"Server Key", "sha256").digest()
b64 = lambda b: base64.b64encode(b).decode()
print(f"SCRAM-SHA-256${rounds}:{b64(salt)}${b64(hashlib.sha256(client).digest())}:{b64(server)}")
')"
export DEXTRANS_READER_PASSWORD DEXTRANS_READER_VERIFIER

echo "== dextrans: read-only role analytics_dextrans_reader"
psql "$DEXTRANS_CONN" -X -w -q -f "$ROOT/db/ops/dextrans_reader.sql"
echo "== dexl: server and user mapping for $(psql "$DEXL_CONN" -X -w -At -c 'select current_user')"
psql "$DEXL_CONN" -X -w -q -f "$ROOT/db/ops/link_dextrans.sql"

unset DEXTRANS_READER_PASSWORD DEXTRANS_READER_VERIFIER
