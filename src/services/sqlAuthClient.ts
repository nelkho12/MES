import type {
  AuthStatusResponse,
  DbConnectionConfigInput,
  DbConnectionConfigPublic,
  DbConnectionTestResult,
  SqlAuthUser,
  UserRole,
} from '../types';

const SQL_TOKEN_KEY = 'kettler_mes_sql_token';

type AuthListener = (user: SqlAuthUser | null) => void;

const listeners = new Set<AuthListener>();
let currentUserState: SqlAuthUser | null = null;

function notifyAuthListeners(user: SqlAuthUser | null) {
  currentUserState = user;
  listeners.forEach((fn) => fn(user));
}

export function subscribeSqlAuth(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCurrentAuthUser(): SqlAuthUser | null {
  return currentUserState;
}

export function getStoredSqlToken(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(SQL_TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function setStoredSqlToken(token: string | null) {
  try {
    if (typeof window === 'undefined') return;
    if (token) {
      window.localStorage.setItem(SQL_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(SQL_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export async function getActiveBearerToken(): Promise<string | null> {
  return getStoredSqlToken();
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) {
    throw new Error(`Unable to read server auth status (${res.status}).`);
  }
  return (await res.json()) as AuthStatusResponse;
}

export async function restoreSqlSession(): Promise<SqlAuthUser | null> {
  const token = getStoredSqlToken();
  if (!token) {
    notifyAuthListeners(null);
    return null;
  }
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setStoredSqlToken(null);
      notifyAuthListeners(null);
      return null;
    }
    const data = (await res.json()) as { user: SqlAuthUser };
    notifyAuthListeners(data.user);
    return data.user;
  } catch {
    return null;
  }
}

export async function loginWithSql(email: string, password: string): Promise<SqlAuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    user?: SqlAuthUser;
    error?: string;
  };
  if (!res.ok || !data.token || !data.user) {
    throw new Error(data.error || `Sign-in failed (${res.status}).`);
  }
  setStoredSqlToken(data.token);
  notifyAuthListeners(data.user);
  return data.user;
}

export async function registerWithSql(input: {
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}): Promise<SqlAuthUser> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    user?: SqlAuthUser;
    error?: string;
  };
  if (!res.ok || !data.token || !data.user) {
    throw new Error(data.error || `Account creation failed (${res.status}).`);
  }
  setStoredSqlToken(data.token);
  notifyAuthListeners(data.user);
  return data.user;
}

export async function changeSqlPassword(
  newPassword: string,
  currentPassword?: string
): Promise<void> {
  const token = await getActiveBearerToken();
  if (!token) throw new Error('Authentication required.');
  const res = await fetch('/api/auth/password', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ newPassword, currentPassword }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Failed to update SQL password (${res.status}).`);
  }
  if (currentUserState) {
    notifyAuthListeners({ ...currentUserState, hasPassword: true });
  }
}

export async function logoutSqlSession(): Promise<void> {
  setStoredSqlToken(null);
  notifyAuthListeners(null);
}

async function systemHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await getActiveBearerToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchDbConnectionConfig(): Promise<DbConnectionConfigPublic> {
  const headers = await systemHeaders();
  const res = await fetch('/api/system/db-config', { headers });
  const data = (await res.json().catch(() => ({}))) as {
    config?: DbConnectionConfigPublic;
    error?: string;
  };
  if (!res.ok || !data.config) {
    throw new Error(data.error || `Unable to load SQL connection config (${res.status}).`);
  }
  return data.config;
}

export async function testDbConnection(
  input: DbConnectionConfigInput
): Promise<DbConnectionTestResult> {
  const headers = await systemHeaders();
  const res = await fetch('/api/system/db-test', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  return (await res.json()) as DbConnectionTestResult;
}

export async function saveDbConnectionConfig(
  input: DbConnectionConfigInput
): Promise<{ config: DbConnectionConfigPublic; testResult: DbConnectionTestResult }> {
  const headers = await systemHeaders();
  const res = await fetch('/api/system/db-config', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as {
    config?: DbConnectionConfigPublic;
    testResult?: DbConnectionTestResult;
    error?: string;
  };
  if (!res.ok || !data.config || !data.testResult) {
    throw new Error(data.error || `Unable to save SQL connection (${res.status}).`);
  }
  return { config: data.config, testResult: data.testResult };
}

export async function resetDbConnectionConfig(): Promise<DbConnectionConfigPublic> {
  const headers = await systemHeaders();
  const res = await fetch('/api/system/db-reset-env', {
    method: 'POST',
    headers,
  });
  const data = (await res.json().catch(() => ({}))) as {
    config?: DbConnectionConfigPublic;
    error?: string;
  };
  if (!res.ok || !data.config) {
    throw new Error(data.error || `Unable to reset SQL connection (${res.status}).`);
  }
  return data.config;
}
