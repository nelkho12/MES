import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDbConfigFilePath } from '../db/connectionConfig.ts';
import {
  createUserRecord,
  getSqlUserStatsSql,
  getUserByEmail,
  getUserByUid,
  updateUserByUid,
} from '../services/sqlService.ts';
import type { SqlAuthUser, UserRole } from '../types.ts';

const TOKEN_PREFIX = 'ksql1.';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VALID_ROLES: UserRole[] = ['operator', 'supervisor', 'qc', 'manager', 'admin'];

let cachedSecret: string | null = null;

function getAuthSecret(): string {
  if (cachedSecret) return cachedSecret;
  const envSecret = process.env.KETTLER_AUTH_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    cachedSecret = envSecret;
    return cachedSecret;
  }

  const secretPath = path.join(path.dirname(resolveDbConfigFilePath()), '.kettler-auth-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) {
        cachedSecret = existing;
        return cachedSecret;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
    cachedSecret = generated;
    return cachedSecret;
  } catch {
    cachedSecret = crypto
      .createHash('sha256')
      .update(`kettler-mes-fallback-${process.env.SQL_HOST || 'local'}-${process.env.SQL_DB_NAME || 'mes'}`)
      .digest('hex');
    return cachedSecret;
  }
}

export function hashSqlPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifySqlPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

interface SqlTokenPayload {
  v: 1;
  uid: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

export function createSqlSessionToken(user: {
  uid: string;
  email: string;
  displayName: string;
}): string {
  const now = Date.now();
  const payload: SqlTokenPayload = {
    v: 1,
    uid: user.uid,
    email: user.email,
    name: user.displayName,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getAuthSecret())
    .update(encoded)
    .digest('base64url');
  return `${TOKEN_PREFIX}${encoded}.${sig}`;
}

export function verifySqlSessionToken(
  token: string
): { uid: string; email: string; name: string } | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dotIdx = body.indexOf('.');
  if (dotIdx <= 0) return null;

  const encoded = body.slice(0, dotIdx);
  const sig = body.slice(dotIdx + 1);
  if (!encoded || !sig) return null;

  try {
    const expectedSig = crypto
      .createHmac('sha256', getAuthSecret())
      .update(encoded)
      .digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<SqlTokenPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.email !== 'string' ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }

    return {
      uid: parsed.uid,
      email: parsed.email,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.email,
    };
  } catch {
    return null;
  }
}

function normalizeRole(role: unknown): UserRole {
  return typeof role === 'string' && VALID_ROLES.includes(role as UserRole)
    ? (role as UserRole)
    : 'manager';
}

export async function getSqlAuthStats(): Promise<{
  sqlUsersCount: number;
  hasPasswordedUsers: boolean;
}> {
  try {
    return await getSqlUserStatsSql();
  } catch {
    return {
      sqlUsersCount: 0,
      hasPasswordedUsers: false,
    };
  }
}

export async function authenticateSqlUser(
  rawEmail: string,
  password: string
): Promise<{ token: string; user: SqlAuthUser }> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) {
    throw new Error('Email or operator ID is required.');
  }
  if (!password) {
    throw new Error('Password is required.');
  }

  const row = await getUserByEmail(email);
  if (!row) {
    throw new Error('Invalid email or password.');
  }
  if (!row.passwordHash) {
    throw new Error(
      'This SQL account has no password configured yet. Please register a new SQL operator account or ask an administrator to assign one.'
    );
  }
  if (!verifySqlPassword(password, row.passwordHash)) {
    throw new Error('Invalid email or password.');
  }

  const user: SqlAuthUser = {
    uid: row.uid,
    email: row.email,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    hasPassword: true,
  };
  const token = createSqlSessionToken(user);
  return { token, user };
}

export async function registerSqlUser(input: {
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}): Promise<{ token: string; user: SqlAuthUser }> {
  const email = input.email.trim().toLowerCase();
  const password = input.password || '';
  const displayName =
    (input.displayName || '').trim() || email.split('@')[0] || 'Plant Operator';

  if (!email || !email.includes('@')) {
    throw new Error('Enter a valid operator email address (e.g. operator@plant.local).');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    throw new Error(
      existing.passwordHash
        ? 'An account with this email already exists. Please sign in instead.'
        : 'This email is already registered in PostgreSQL without a local password. Please use another operator email.'
    );
  }

  const stats = await getSqlAuthStats();
  const role: UserRole = stats.sqlUsersCount === 0 ? 'admin' : normalizeRole(input.role);
  const uid = `sql-${crypto.randomUUID()}`;
  const passwordHash = hashSqlPassword(password);

  await createUserRecord({
    uid,
    email,
    displayName,
    passwordHash,
    role,
  });

  const user: SqlAuthUser = {
    uid,
    email,
    displayName,
    role,
    hasPassword: true,
  };
  const token = createSqlSessionToken(user);
  return { token, user };
}

export async function updateSqlUserPassword(
  uid: string,
  newPassword: string,
  currentPassword?: string
): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New SQL password must be at least 6 characters.');
  }
  const row = await getUserByUid(uid);
  if (!row) {
    throw new Error('User record not found in SQL database.');
  }
  if (row.passwordHash) {
    if (!currentPassword || !verifySqlPassword(currentPassword, row.passwordHash)) {
      throw new Error('Current SQL password does not match.');
    }
  }
  const nextHash = hashSqlPassword(newPassword);
  await updateUserByUid(uid, { passwordHash: nextHash });
}

export async function getSqlUserSummary(uid: string): Promise<SqlAuthUser | null> {
  const row = await getUserByUid(uid);
  if (!row) return null;
  return {
    uid: row.uid,
    email: row.email,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    hasPassword: Boolean(row.passwordHash),
  };
}
