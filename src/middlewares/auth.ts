import { FastifyRequest } from "fastify";
import { verifyAccessToken } from "../utils/jwt";

export interface AuthPayload {
  sub: string;
  name?: string;
  email?: string;
  roles: string[];
  displayName?: string;
  [key: string]: any;
}

export async function requireAuth(req: FastifyRequest): Promise<AuthPayload> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { statusCode: 401, message: 'Missing or invalid authorization header' };
  }

  const token = authHeader.substring(7);
  try {
    const payload = await verifyAccessToken(token);
    return {
      sub: payload.sub,
      name: payload.name,
      email: payload.email,
      roles: payload.roles || [],
      displayName: payload.displayName
    };
  } catch (error) {
    throw { statusCode: 401, message: 'Invalid or expired token' };
  }
}

export async function optionalAuth(req: FastifyRequest): Promise<AuthPayload | null> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  try {
    const payload = await verifyAccessToken(token);
    return {
      sub: payload.sub,
      name: payload.name,
      email: payload.email,
      roles: payload.roles || [],
      displayName: payload.displayName
    };
  } catch (error) {
    return null;
  }
}

export function requireRole(payload: AuthPayload, allowedRoles: string[]): void {
  if (!payload.roles.some(role => allowedRoles.includes(role))) {
    throw { statusCode: 403, message: `Access denied. Required roles: ${allowedRoles.join(', ')}` };
  }
}
