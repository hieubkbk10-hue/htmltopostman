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
      includePatch: true,
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

test('runLiveApiRequests in safe GET-only mode resolves query parameters and skips mutating endpoints', async () => {
  const calledUrls = [];

  const server = http.createServer((req, res) => {
    calledUrls.push(`${req.method} ${req.url}`);

    if (req.url === '/v1/domains' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 1, domain_name: 'testdomain', domain_ext: '.com' },
        ],
      }));
    } else if (req.url.startsWith('/v1/domains/check-whois') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { exists: true, domain: req.url },
      }));
    } else if (req.url === '/v1/domains/1' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { id: 1, domain: 'testdomain.com' },
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
      name: 'GetDomains',
      method: 'GET',
      url: '/v1/domains',
      group: 'Domain',
      permission: 'Authenticated',
    },
    {
      name: 'CheckWhois',
      method: 'GET',
      url: '/v1/domains/check-whois',
      group: 'Domain',
      permission: 'Authenticated',
      query: [{ field: 'domain', optional: false }],
    },
    {
      name: 'GetDomainById',
      method: 'GET',
      url: '/v1/domains/:id',
      group: 'Domain',
      permission: 'Authenticated',
    },
    {
      name: 'UpdateDomain',
      method: 'PATCH',
      url: '/v1/domains/:id',
      group: 'Domain',
      body: [{ field: 'name', defaultValue: 'New Domain' }],
      permission: 'Authenticated',
    },
  ];

  try {
    const responsesMap = await runLiveApiRequests({
      baseUrl,
      token: 'test-token',
      endpoints,
      // includePatch is false by default
    });

    assert.equal(responsesMap.size, 3); // 3 GET endpoints captured, PATCH skipped
    assert.ok(calledUrls.includes('GET /v1/domains'));
    assert.ok(calledUrls.some(u => u.startsWith('GET /v1/domains/check-whois?domain=')));
    assert.ok(calledUrls.includes('GET /v1/domains/1'));
    assert.ok(!calledUrls.some(u => u.startsWith('PATCH')));
  } finally {
    server.close();
  }
});
