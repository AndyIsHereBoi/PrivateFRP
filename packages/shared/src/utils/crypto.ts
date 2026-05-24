import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

export function randomId(prefix = ''): string {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

export function randomSecret(bytes = 24): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretsMatch(expectedHash: string, candidateSecret: string): boolean {
  const actualHash = hashSecret(candidateSecret);
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function nowMs(): number {
  return Date.now();
}