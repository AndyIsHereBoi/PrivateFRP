/**
 * Certificate validator for agent-server TLS connections
 */

export interface TrustedCertificates {
  serverCert: string;
}

const TRUSTED_CERTS_PATH = "./data/trusted-certs.json";

/**
 * Load trusted certificates from file
 */
export async function loadTrustedCertificates(): Promise<TrustedCertificates | null> {
  try {
    const content = await Bun.file(TRUSTED_CERTS_PATH).text();
    return JSON.parse(content) as TrustedCertificates;
  } catch (e) {
    // File doesn't exist or can't be read
    return null;
  }
}

/**
 * Save trusted certificates to file
 */
export async function saveTrustedCertificates(cert: string): Promise<void> {
  const data: TrustedCertificates = { serverCert: cert };
  
  // Ensure directory exists
  const certDir = TRUSTED_CERTS_PATH.substring(0, TRUSTED_CERTS_PATH.lastIndexOf('/'));
  Bun.write(`${certDir}/.keep`, "");
  
  Bun.write(TRUSTED_CERTS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Validate the server certificate against stored trusted certificate
 * @returns true if valid, false otherwise
 */
export async function validateServerCertificate(serverCert: string): Promise<boolean> {
  const trusted = await loadTrustedCertificates();
  
  if (!trusted) {
    // No trusted cert stored yet - this is the first connection
    return true;
  }

  return serverCert === trusted.serverCert;
}

/**
 * Get the path to the trusted certificates file
 */
export function getTrustedCertsPath(): string {
  return TRUSTED_CERTS_PATH;
}
