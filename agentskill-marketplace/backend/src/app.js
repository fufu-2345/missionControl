import express from 'express';
import cors from 'cors';
import { router as authRouter } from './auth.js';
import { router as skillsRouter } from './skills.js';
import { router as metaRouter } from './meta.js';
import { router as adminRouter } from './admin.js';
import { router as statsRouter } from './stats.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/admin', adminRouter);
  // Meta lists: /api/tags, /api/categories and /api/groups.
  app.use('/api', metaRouter);
  // Charts + recommendations: /api/stats/... and /api/recommendations.
  app.use('/api', statsRouter);

  return app;
}

export const app = createApp();

export default app;
