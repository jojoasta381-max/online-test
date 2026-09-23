import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { app } from '../index.js';
import { getAllowedOrigins, isSameOrigin, isOriginAllowed, normalizeOrigin } from '../middleware/corsConfig.js';

describe('Production CORS Security & Configuration Suite', () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  const originalCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    // Reset to default test state before each test
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalAllowedOrigins !== undefined) {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }

    if (originalCorsAllowedOrigins !== undefined) {
      process.env.CORS_ALLOWED_ORIGINS = originalCorsAllowedOrigins;
    } else {
      delete process.env.CORS_ALLOWED_ORIGINS;
    }
  });

  describe('1. Configured Origin => Allowed', () => {
    it('should allow GET request from configured origin and set credentials and specific origin', async () => {
      process.env.ALLOWED_ORIGINS = 'http://test-dashboard.internal';

      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://test-dashboard.internal');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://test-dashboard.internal');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
      expect(res.body.status).toBe('UP');
    });

    it('should allow preflight OPTIONS request from configured origin', async () => {
      process.env.ALLOWED_ORIGINS = 'http://test-dashboard.internal';

      const res = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://test-dashboard.internal')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://test-dashboard.internal');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    it('should allow authentication requests from configured origin', async () => {
      process.env.ALLOWED_ORIGINS = 'http://test-dashboard.internal';

      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://test-dashboard.internal')
        .send({ email: 'nonexistent@example.com', password: 'Password123' });

      // Should reach auth controller (401 invalid creds), NOT 403 CORS rejection
      expect(res.status).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe('http://test-dashboard.internal');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('2. Unconfigured Origin => Rejected', () => {
    it('should reject GET request with unconfigured origin with 403 Forbidden', async () => {
      process.env.ALLOWED_ORIGINS = 'http://allowed-domain.org';

      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://malicious-site.com');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('CORS policy violation: Origin not allowed.');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should reject preflight OPTIONS request with unconfigured origin with 403 Forbidden', async () => {
      process.env.ALLOWED_ORIGINS = 'http://allowed-domain.org';

      const res = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://unauthorized-attacker.net')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('CORS policy violation: Origin not allowed.');
    });

    it('should reject POST request with unconfigured origin with 403 Forbidden', async () => {
      process.env.ALLOWED_ORIGINS = 'http://allowed-domain.org';

      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://rogue-client.io')
        .send({ email: 'admin@acme.com', password: 'Password123' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('CORS policy violation: Origin not allowed.');
    });
  });

  describe('3. No Origin => Works (curl / server-to-server / health checks)', () => {
    it('should allow GET requests without Origin header', async () => {
      process.env.ALLOWED_ORIGINS = 'http://allowed-domain.org';

      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
      // No Origin header sent, so no Access-Control-Allow-Origin needed
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should allow POST requests without Origin header to reach application logic', async () => {
      process.env.ALLOWED_ORIGINS = 'http://allowed-domain.org';

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'user@example.com', password: 'wrong' });

      // Reaches auth handler, not rejected by CORS
      expect(res.status).toBe(401);
      expect(res.body.error).not.toContain('CORS');
    });
  });

  describe('4. Credentials Remain Enabled', () => {
    it('should explicitly set Access-Control-Allow-Credentials: true on allowed origin', async () => {
      process.env.ALLOWED_ORIGINS = 'https://app.custom-domain.com';

      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://app.custom-domain.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-origin']).toBe('https://app.custom-domain.com');
      // Never use wildcard '*' when credentials are true
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });
  });

  describe('5. Multiple Comma-Separated Origins Work', () => {
    it('should support multiple origins and normalize whitespace and trailing slashes', async () => {
      process.env.ALLOWED_ORIGINS = 'http://site-alpha.com, https://site-beta.org/ , http://site-gamma.io:8080';

      const origins = getAllowedOrigins();
      expect(origins).toEqual([
        'http://site-alpha.com',
        'https://site-beta.org',
        'http://site-gamma.io:8080',
      ]);

      // Origin 1
      const res1 = await request(app)
        .get('/api/health')
        .set('Origin', 'http://site-alpha.com');
      expect(res1.status).toBe(200);
      expect(res1.headers['access-control-allow-origin']).toBe('http://site-alpha.com');

      // Origin 2 (configured with trailing slash, requested without or with)
      const res2 = await request(app)
        .get('/api/health')
        .set('Origin', 'https://site-beta.org');
      expect(res2.status).toBe(200);
      expect(res2.headers['access-control-allow-origin']).toBe('https://site-beta.org');

      // Origin 3 with port
      const res3 = await request(app)
        .get('/api/health')
        .set('Origin', 'http://site-gamma.io:8080');
      expect(res3.status).toBe(200);
      expect(res3.headers['access-control-allow-origin']).toBe('http://site-gamma.io:8080');

      // Origin 4 (not in the comma-separated list) => Rejected
      const res4 = await request(app)
        .get('/api/health')
        .set('Origin', 'http://site-delta.com');
      expect(res4.status).toBe(403);
      expect(res4.body.error).toBe('CORS policy violation: Origin not allowed.');
    });
  });

  describe('6. Browser Requests from the Same Origin', () => {
    it('should allow browser requests when Origin matches Host header', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Host', 'app.internal-server.net')
        .set('Origin', 'http://app.internal-server.net');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://app.internal-server.net');
    });

    it('should allow browser requests when Origin matches X-Forwarded-Host reverse proxy header', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Host', '127.0.0.1:5000')
        .set('X-Forwarded-Host', 'production.example.com')
        .set('Origin', 'https://production.example.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://production.example.com');
    });
  });

  describe('7. Helper Unit Checks (isOriginAllowed, isSameOrigin, normalizeOrigin)', () => {
    it('should correctly normalize origins', () => {
      expect(normalizeOrigin('  http://example.com/  ')).toBe('http://example.com');
      expect(normalizeOrigin('https://secure.org///')).toBe('https://secure.org');
    });

    it('should correctly evaluate same origin matching', () => {
      const mockReq = {
        headers: { host: '3.231.102.135', 'x-forwarded-host': '3.231.102.135' }
      } as any;

      expect(isSameOrigin('http://3.231.102.135', mockReq)).toBe(true);
      expect(isSameOrigin('http://different.com', mockReq)).toBe(false);
    });

    it('should return default origins when no environment variable is set', () => {
      delete process.env.ALLOWED_ORIGINS;
      delete process.env.CORS_ALLOWED_ORIGINS;

      const defaults = getAllowedOrigins();
      expect(defaults).toContain('http://localhost:3000');
      expect(defaults).toContain('http://localhost:5000');
      expect(defaults).toContain('http://localhost:5173');
    });
  });

  describe('8. Static Frontend Assets (/assets/*)', () => {
    const assetsDir = path.join(process.cwd(), 'client', 'dist', 'assets');
    const dummyJsFile = path.join(assetsDir, 'mock-asset.js');
    const dummyCssFile = path.join(assetsDir, 'mock-asset.css');

    beforeAll(() => {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(dummyJsFile, 'console.log("mock asset");');
      fs.writeFileSync(dummyCssFile, 'body { color: blue; }');
    });

    afterAll(() => {
      try { fs.unlinkSync(dummyJsFile); } catch {}
      try { fs.unlinkSync(dummyCssFile); } catch {}
    });

    it('should serve /assets/*.js to configured origin with credentials and CORS headers', async () => {
      process.env.ALLOWED_ORIGINS = 'http://test-dashboard.internal';

      const res = await request(app)
        .get('/assets/mock-asset.js')
        .set('Origin', 'http://test-dashboard.internal');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://test-dashboard.internal');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['content-type']).toContain('javascript');
    });

    it('should serve /assets/*.css to same-origin browser requests with CORS headers', async () => {
      const res = await request(app)
        .get('/assets/mock-asset.css')
        .set('Host', '3.231.102.135')
        .set('Origin', 'http://3.231.102.135');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://3.231.102.135');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['content-type']).toContain('css');
    });

    it('should reject requests to /assets/*.js from unconfigured origin with 403 Forbidden', async () => {
      process.env.ALLOWED_ORIGINS = 'http://test-dashboard.internal';

      const res = await request(app)
        .get('/assets/mock-asset.js')
        .set('Origin', 'http://malicious-external-site.com');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('CORS policy violation: Origin not allowed.');
    });
  });
});
