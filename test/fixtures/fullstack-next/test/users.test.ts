import { createServer } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/users/route';

// Minimal adapter so supertest can exercise the route handler.
const app = createServer(async (_req, res) => {
  const response = await GET();
  res.writeHead(response.status, { 'Content-Type': 'application/json' });
  res.end(await response.text());
});

describe('users API', () => {
  it('lists users', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
  });

  it('deletes a user', async () => {
    await request(app).delete('/api/users/1').expect(204);
  });
});
