import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(filePath = path.join(projectRoot, 'server', '.env')) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator === -1) {
      continue;
    }

    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }

  return values;
}

export function deriveImportSourceName(importUrl) {
  try {
    const hostname = new URL(importUrl).hostname.replace(/^www\./i, '');

    if (/^(localhost|127\.|\[?::1\]?$)/i.test(hostname)) {
      return 'JSONPlaceholder';
    }

    const label = hostname.split('.')[0].replace(/[^a-z0-9]+/gi, ' ').trim();

    if (!label) {
      return 'JSONPlaceholder';
    }

    if (label.toLowerCase() === 'jsonplaceholder') {
      return 'JSONPlaceholder';
    }

    return label
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } catch {
    return 'JSONPlaceholder';
  }
}

export function createConfig(overrides = {}) {
  const env = { ...loadEnv(), ...process.env, ...overrides };
  const configuredSecret = overrides.secret || env.API_JWT_SECRET;
  const importUrl = overrides.importUrl || env.IMPORT_SOURCE_URL || 'https://jsonplaceholder.typicode.com/todos';
  const derivedSourceName = deriveImportSourceName(importUrl);
  const configuredSourceName = overrides.importSourceName || env.IMPORT_SOURCE_NAME;
  const importSourceName =
    typeof configuredSourceName === 'string' && configuredSourceName.trim()
      ? configuredSourceName.trim().slice(0, 60)
      : derivedSourceName;
  const importTimeoutMs = Number(overrides.importTimeoutMs ?? env.IMPORT_TIMEOUT_MS ?? 8000);
  const allowedOrigins = (env.ALLOWED_ORIGINS || 'http://localhost:4200,http://localhost:8100')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: Number(overrides.port ?? env.API_PORT ?? 3000),
    secret: configuredSecret || randomBytes(32).toString('hex'),
    ephemeralSecret: !configuredSecret,
    storePath: overrides.storePath || env.API_STORE_PATH || path.join(projectRoot, 'server', 'data', 'store.json'),
    importUrl,
    importLimit: Number(overrides.importLimit ?? env.IMPORT_LIMIT ?? 10),
    importSourceName,
    importTimeoutMs: Number.isFinite(importTimeoutMs) && importTimeoutMs > 0 ? importTimeoutMs : 8000,
    allowedOrigins,
  };
}

export { projectRoot };
