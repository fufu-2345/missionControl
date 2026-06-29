import express from 'express';
import cors from 'cors';
import { router as authRouter } from './auth.js';
import { router as skillsRouter } from './skills.js';
import { router as metaRouter } from './meta.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/skills', skillsRouter);
  // Meta lists: /api/tags and /api/categories.
  app.use('/api', metaRouter);

  return app;
}

export const app = createApp();

export default app;
