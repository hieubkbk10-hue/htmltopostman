import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loginAdmin } from '../src/auth.js';

test('loginAdmin successfully extracts token from valid login response', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/clients/web/login' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.email === 'admin@admin' && parsed.password === 'admin') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            token_type: 'Bearer',
            access_token: 'fake-jwt-token-12345',
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Invalid credentials' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    const result = await loginAdmin({ baseUrl, email: 'admin@admin', password: 'admin' });
    assert.equal(result.success, true);
    assert.equal(result.token, 'fake-jwt-token-12345');

    const failedResult = await loginAdmin({ baseUrl, email: 'wrong', password: 'wrong' });
    assert.equal(failedResult.success, false);
  } finally {
    server.close();
  }
});
