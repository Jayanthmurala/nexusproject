import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { env } from "../config/env";

const JWKS = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));

export type AccessTokenPayload = JWTPayload & {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  displayName?: string;
  avatarUrl?: string;
  roles?: string[];
  tv?: number;
};

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    console.log('[JWT] Verifying token with config:', {
      issuer: env.AUTH_JWT_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE,
      jwksUrl: env.AUTH_JWKS_URL
    });
    
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.AUTH_JWT_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE,
    });
    
    console.log('[JWT] Token verified successfully:', {
      sub: payload.sub,
      email: payload.email,
      roles: payload.roles,
      iss: payload.iss,
      aud: payload.aud
    });
    
    return payload as AccessTokenPayload;
  } catch (error) {
    console.error('[JWT] Token verification failed:', error);
    throw error;
  }
}
