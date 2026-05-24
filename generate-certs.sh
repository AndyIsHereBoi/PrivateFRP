#!/bin/bash

# PrivateFRP Certificate Generation Script
# Generates self-signed TLS certificates for agent-server communication

set -e

CERT_DIR="${1:-./certs}"

echo "Creating certificate directory: $CERT_DIR"
mkdir -p "$CERT_DIR"

echo "Generating RSA private key..."
openssl genrsa -out "$CERT_DIR/server.key" 2048

echo "Generating self-signed certificate..."
openssl req -new -x509 -key "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" -days 365 -subj "/CN=localhost/O=PrivateFRP/C=US"

echo ""
echo "Certificates generated successfully!"
echo "  Key:  $CERT_DIR/server.key"
echo "  Cert: $CERT_DIR/server.crt"
echo ""
echo "To use these certificates, set the following in server.env:"
echo "  AGENT_TLS_CERT=$CERT_DIR/server.crt"
echo "  AGENT_TLS_KEY=$CERT_DIR/server.key"
