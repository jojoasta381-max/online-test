import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth.js';
import { jobsRouter } from './routes/jobs.js';
import { templatesRouter } from './routes/templates.js';
import { candidatesRouter } from './routes/candidates.js';
import { assessmentRouter } from './routes/assessment.js';
import { adminRouter } from './routes/admin.js';
import { analyticsRouter } from './routes/analytics.js';
import { aiGeneratorRouter } from './routes/aiGenerator.js';
import { interviewsRouter } from './routes/interviews.js';
import { badgesRouter } from './routes/badges.js';
import { webhooksRouter } from './routes/webhooks.js';
import { notificationsRouter } from './routes/notifications.js';
import { tenantsRouter } from './routes/tenants.js';
import { legalRouter } from './routes/legal.js';

import { securityHeaders } from './middleware/securityHeaders.js';
import { enforceStartupConfig } from './middleware/auth.js';
import { resolveTenant } from './middleware/tenant.js';
import { corsMiddleware } from './middleware/corsConfig.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust reverse proxy (nginx / load balancer)
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(corsMiddleware);

app.use(express.json({ limit: '10mb' }));
app.use(resolveTenant);

// NOTE: Public static serving of /uploads is REMOVED to protect candidate PII.
// Resumes and proctoring snapshots are strictly accessed through authenticated endpoints:
// GET /api/candidates/:applicationId/resume
// GET /api/candidates/:applicationId/snapshots/:filename

// API Routers
app.use('/api/tenants', tenantsRouter);
app.use('/api/auth', authRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/assessment', assessmentRouter);
app.use('/api/admin', adminRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin/ai-generator', aiGeneratorRouter);
app.use('/api/ai', aiGeneratorRouter);
app.use('/api/interviews', interviewsRouter);
app.use('/api/badges', badgesRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/legal', legalRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'UP', service: 'TechScreen Pro Backend API', timestamp: new Date() });
});

// Explicitly block public static access to /uploads with 404
app.all('/uploads/*', (req, res) => {
  res.status(404).json({ success: false, error: 'Public static file access to /uploads is disabled. Authenticated endpoints must be used.' });
});

// Serve frontend static build if available
const clientDistDir = fs.existsSync(path.join(process.cwd(), 'client'))
  ? path.join(process.cwd(), 'client', 'dist')
  : path.resolve(process.cwd(), '..', 'client', 'dist');

app.use(express.static(clientDistDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return next();
  }
  const indexPath = path.join(clientDistDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Global error handling middleware (Sanitized for production)
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ success: false, error: 'Payload too large: Request body exceeds allowed size.' });
  }
  if (err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload.' });
  }
  if (err.message === 'Blocked by CORS security policy.') {
    return res.status(403).json({ success: false, error: 'CORS policy violation: Origin not allowed.' });
  }

  // Server-side detailed logging (without leaking secrets)
  console.error('[SERVER ERROR]', err.message || err);

  const statusCode = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';
  const safeMessage = isProd
    ? 'An internal server error occurred. Please contact system support.'
    : err.message || 'Internal server error';

  return res.status(statusCode).json({ success: false, error: safeMessage });
});

if (process.env.NODE_ENV !== 'test') {
  enforceStartupConfig();
  app.listen(PORT, (err?: any) => {
    if (err) {
      console.error('Error starting server:', err);
    } else {
      console.log(`🚀 TechScreen Pro Server listening on http://localhost:${PORT}`);
    }
  });
}

export { app };
