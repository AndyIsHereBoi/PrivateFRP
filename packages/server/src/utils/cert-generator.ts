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
  const privateKey = `-----BEGIN RSA Private Key-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHmJYz51xkPbX6f4h2R9
-----END RSA Private Key-----`;

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
export async function loadOrCreateCertificate(certPath: string, keyPath: string): Promise<CertificatePair> {
  // Check if certificate file exists
  try {
    const certContent = await Bun.file(certPath).text();
    const keyContent = await Bun.file(keyPath).text();

    if (certContent && keyContent) {
      console.log(`Loading certificates from ${certPath}`);
      return { cert: certContent, key: keyContent };
    }
  } catch (e) {
    // File doesn't exist or can't be read, will generate new ones
  }

  // Generate and save certificates
  console.log("Generating certificates...");
  const { cert, key } = generateCert();

  // Ensure directory exists
  const certDir = certPath.substring(0, certPath.lastIndexOf('/'));
  Bun.write(`${certDir}/.keep`, "");

  // Save certificate files
  Bun.write(certPath, cert);
  Bun.write(keyPath, key);

  console.log(`Certificates saved to ${certPath} and ${keyPath}`);

  return { cert, key };
}

/**
 * Get default certificate paths
 */
export function getDefaultCertPaths(): { cert: string; key: string } {
  return {
    cert: "./data/certs/server.crt",
    key: "./data/certs/server.key",
  };
}
