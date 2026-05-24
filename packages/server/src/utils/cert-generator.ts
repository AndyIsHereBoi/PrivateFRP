/**
 * Generate a self-signed TLS certificate for development
 */

export interface CertificatePair {
  cert: string;
  key: string;
}

/**
 * Generate a placeholder self-signed certificate (for development only)
 */
function generatePlaceholderCert(): CertificatePair {
  const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHmJYz51xkPbX6f4h2R9
-----END RSA PRIVATE KEY-----`;

  const certificate = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAJC1HiIAZAiUMA0GCSqGSIb3DQEBCwUAME0xCzAJBgNV
BAYTAlVTMREwDwYDVQQKDAhQcml2YXRlRlJQMRgwFgYDVQQDDA9sb2NhbGhvc3Qw
-----END CERTIFICATE-----`;

  return { cert: certificate, key: privateKey };
}

/**
 * Generate a self-signed TLS certificate
 */
export function generateCert(): CertificatePair {
  // For production, use openssl to generate certificates:
  // openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
  console.warn("Warning: Using placeholder certificate. For production, use openssl to generate certificates.");
  return generatePlaceholderCert();
}

/**
 * Load certificate from files or generate new ones if they don't exist
 */
export function loadOrCreateCertificate(certPath: string, keyPath: string): CertificatePair {
  // In Bun, we would use Bun.file() to read/write files
  // For now, generate certificates each time (placeholder implementation)
  console.log("Generating certificates...");
  return generateCert();
}

/**
 * Get default certificate paths
 */
export function getDefaultCertPaths(): { cert: string; key: string } {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return {
    cert: `${home}/.privatefrp/server.crt`,
    key: `${home}/.privatefrp/server.key`,
  };
}
