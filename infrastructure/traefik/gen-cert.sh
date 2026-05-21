#!/bin/sh
# Generates a self-signed TLS certificate for local/IP deployment.
# Usage: ./gen-cert.sh [HOST_OR_IP]
# Example: ./gen-cert.sh 94.103.13.192
set -e

HOST="${1:-localhost}"
OUT_DIR="$(dirname "$0")/certs"
mkdir -p "$OUT_DIR"

echo "[gen-cert] Generating self-signed cert for: $HOST"

openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$OUT_DIR/server.key" \
    -out "$OUT_DIR/server.crt" \
    -days 825 \
    -subj "/CN=$HOST" \
    -addext "subjectAltName=IP:$HOST,DNS:localhost" 2>/dev/null || \
openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$OUT_DIR/server.key" \
    -out "$OUT_DIR/server.crt" \
    -days 825 \
    -subj "/CN=$HOST"

echo "[gen-cert] Wrote:"
echo "  $OUT_DIR/server.crt"
echo "  $OUT_DIR/server.key"
