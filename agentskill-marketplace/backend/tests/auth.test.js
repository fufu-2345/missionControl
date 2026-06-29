import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
// Assumes bob exports the Express app as a NAMED export `app` from src/app.js
// (consistent with db.js named exports). If bob ships it as the default
// export, change to: `import app from '../src/app.js'`.
import { app } from '../src/app.js';

// Unique username per run so re-running the suite against a persistent
// SQLite file does not collide on the UNIQUE(username) constraint.
const username = `john_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const password = 'S3cret-pass!';

describe('GET /api/health', () => {
  it('returns { ok: true }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});

describe('POST /api/auth/register', () => {
  it('registers a fresh user → 200/201 with { token, user }', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password });

    // Spec §5 says register -> {token,user} but is silent on the status code.
    // bob's impl returns 201 (Created); accept either 200 or 201.
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(res.body.user).toMatchObject({ username, role: 'user' });
    // Never leak the password hash to clients.
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects a duplicate username', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password });
    // Spec leaves the exact code open; any 4xx is acceptable, not a 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials → token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username, password });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(res.body.user).toMatchObject({ username, role: 'user' });
  });

  it('rejects a wrong password → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'totally-wrong-password' });

    expect(res.status).toBe(401);
  });

  it('rejects an unknown username → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: `nope_${Date.now()}`, password });

    expect(res.status).toBe(401);
  });
});
