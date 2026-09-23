import type { Request } from 'express';
import cors from 'cors';

/**
 * Normalizes an origin string by trimming whitespace and removing trailing slashes.
 */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * Retrieves the list of allowed origins from environment configuration.
 * Checked in order:
 * 1. process.env.ALLOWED_ORIGINS (comma-separated)
 * 2. process.env.CORS_ALLOWED_ORIGINS (comma-separated fallback)
 * 3. Default development localhost origins
 */
export function getAllowedOrigins(): string[] {
  const envOrigins = process.env.ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS;
  if (envOrigins) {
    return envOrigins
      .split(',')
      .map(o => normalizeOrigin(o))
      .filter(Boolean);
  }
  return ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:5173'];
}

/**
 * Determines whether an incoming origin matches the application's own host (same-origin).
 * Handles direct host headers, X-Forwarded-Host (from reverse proxies like Nginx/ALB),
 * and standard ports.
 */
export function isSameOrigin(origin: string, req: Request): boolean {
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const hostHeader = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (!hostHeader) return false;

    // x-forwarded-host may be comma-separated if multiple proxies
    const primaryHost = hostHeader.split(',')[0].trim().toLowerCase();
    const originHost = originUrl.host.toLowerCase(); // includes hostname:port if non-default

    if (originHost === primaryHost) {
      return true;
    }

    // Compare hostname without port
    const primaryHostname = primaryHost.split(':')[0];
    const originHostname = originUrl.hostname.toLowerCase();
    if (primaryHostname === originHostname) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Checks if a given origin is permitted.
 * - Missing Origin (curl, server-to-server, health checks) => Allowed
 * - Explicitly in ALLOWED_ORIGINS => Allowed
 * - Same origin as the request host => Allowed
 * - Anything else => Rejected
 */
export function isOriginAllowed(origin: string | undefined, req: Request): boolean {
  if (!origin) {
    return true; // No Origin header
  }

  const normalized = normalizeOrigin(origin);
  const allowed = getAllowedOrigins();

  if (allowed.includes(normalized)) {
    return true;
  }

  if (isSameOrigin(origin, req)) {
    return true;
  }

  return false;
}

/**
 * Express CORS options delegate.
 * Dynamically resolves allowed origins, supports credentials, and blocks unconfigured origins.
 */
export const corsOptionsDelegate = (
  req: Request,
  callback: (err: Error | null, options?: cors.CorsOptions) => void
) => {
  const origin = req.headers.origin;

  // 1. No Origin header (curl, health checks, server-to-server)
  if (!origin) {
    return callback(null, { origin: false });
  }

  // 2. Validate Origin against allowed list or same-origin
  if (isOriginAllowed(origin, req)) {
    return callback(null, {
      origin: true, // Reflects the request origin in Access-Control-Allow-Origin (never wildcard '*')
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-auth-token',
        'x-assessment-token',
        'x-tenant-slug',
        'x-tenant-id',
        'x-test-rate-limit',
      ],
      exposedHeaders: ['Content-Range', 'X-Content-Range'],
      maxAge: 86400,
    });
  }

  // 3. Reject unknown origin
  return callback(new Error('Blocked by CORS security policy.'));
};

export const corsMiddleware = cors(corsOptionsDelegate);
