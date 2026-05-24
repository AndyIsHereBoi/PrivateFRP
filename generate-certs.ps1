# PrivateFRP Certificate Generation Script (PowerShell)
# Generates self-signed TLS certificates for agent-server communication

param(
    [string]$CertDir = "./certs"
)

Write-Host "Creating certificate directory: $CertDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $CertDir -Force | Out-Null

Write-Host "Generating RSA private key..." -ForegroundColor Cyan
openssl genrsa -out "$CertDir/server.key" 2048

Write-Host "Generating self-signed certificate..." -ForegroundColor Cyan
openssl req -new -x509 -key "$CertDir/server.key" -out "$CertDir/server.crt" -days 365 -subj "/CN=localhost/O=PrivateFRP/C=US"

Write-Host ""
Write-Host "Certificates generated successfully!" -ForegroundColor Green
Write-Host "  Key:  $CertDir/server.key"
Write-Host "  Cert: $CertDir/server.crt"
Write-Host ""
Write-Host "To use these certificates, set the following in server.env:" -ForegroundColor Yellow
Write-Host "  AGENT_TLS_CERT=$CertDir/server.crt"
Write-Host "  AGENT_TLS_KEY=$CertDir/server.key"
