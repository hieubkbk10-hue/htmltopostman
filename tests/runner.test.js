import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runLiveApiRequests } from '../src/runner.js';

test('runLiveApiRequests crawls IDs from list and calls detail and patch endpoints', async () => {
  const calledUrls = [];

  const server = http.createServer((req, res) => {
    calledUrls.push(`${req.method} ${req.url}`);

    if (req.url === '/v1/users' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'user-id-999', name: 'John Doe' },
        ],
      }));
    } else if (req.url === '/v1/users/user-id-999' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { id: 'user-id-999', name: 'John Doe', email: 'john@example.com' },
      }));
    } else if (req.url === '/v1/users/user-id-999' && req.method === 'PATCH') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { id: 'user-id-999', updated: true },
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const endpoints = [
    {
      name: 'GetAllUsers',
      method: 'GET',
      url: '/v1/users',
      group: 'User',
      permission: 'Authenticated',
    },
    {
      name: 'FindUserById',
      method: 'GET',
      url: '/v1/users/:id',
      group: 'User',
      permission: 'Authenticated',
    },
    {
      name: 'UpdateUser',
      method: 'PATCH',
      url: '/v1/users/:id',
      group: 'User',
      body: [{ field: 'name', defaultValue: 'New Name' }],
      permission: 'Authenticated',
    },
  ];

  try {
    const responsesMap = await runLiveApiRequests({
      baseUrl,
      token: 'test-token',
      endpoints,
      patchLimit: 5,
    });

    assert.equal(responsesMap.size, 3);
    assert.ok(calledUrls.includes('GET /v1/users'));
    assert.ok(calledUrls.includes('GET /v1/users/user-id-999'));
    assert.ok(calledUrls.includes('PATCH /v1/users/user-id-999'));

    const listResp = responsesMap.get('GetAllUsers');
    assert.equal(listResp[0].code, 200);
    assert.ok(listResp[0].body.includes('user-id-999'));
  } finally {
    server.close();
  }
});
