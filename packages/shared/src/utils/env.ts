export function readString(env: Record<string, string | undefined>, key: string, fallback = ''): string {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function readRequiredString(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function readBool(env: Record<string, string | undefined>, key: string, fallback = false): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function readJson<T>(env: Record<string, string | undefined>, key: string, fallback: T): T {
  const value = env[key];
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}