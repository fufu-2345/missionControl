import express from 'express';
import cors from 'cors';
import { router as authRouter } from './auth.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);

  return app;
}

export const app = createApp();

export default app;
