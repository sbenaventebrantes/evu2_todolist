import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) {
    return false;
  }

  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 32).toString('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signToken(user, secret, ttlSeconds = 60 * 60 * 24) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: user.id, email: user.email, iat: now, exp: now + ttlSeconds });
  const signature = createSignature(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

function createSignature(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') {
    throw new HttpError(401, 'Sesión inválida. Vuelve a iniciar sesión.');
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new HttpError(401, 'Sesión inválida. Vuelve a iniciar sesión.');
  }

  const [header, payload, signature] = parts;
  const expected = createSignature(`${header}.${payload}`, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new HttpError(401, 'Sesión inválida. Vuelve a iniciar sesión.');
  }

  let decoded;

  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Sesión inválida. Vuelve a iniciar sesión.');
  }

  if (!decoded.sub || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, 'La sesión venció. Vuelve a iniciar sesión.');
  }

  return decoded;
}
