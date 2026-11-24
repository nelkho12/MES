import type { Request, Response, NextFunction } from 'express';
import { verifySqlSessionToken } from '../lib/sqlAuth.ts';

export interface AuthenticatedPrincipal {
  uid: string;
  email?: string;
  name?: string;
  authProvider: 'sql';
}

export interface AuthRequest extends Request {
  user?: AuthenticatedPrincipal;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split('Bearer ')[1];
  const sqlPrincipal = verifySqlSessionToken(token);
  if (!sqlPrincipal) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
  }

  req.user = {
    uid: sqlPrincipal.uid,
    email: sqlPrincipal.email,
    name: sqlPrincipal.name,
    authProvider: 'sql',
  };
  next();
};
