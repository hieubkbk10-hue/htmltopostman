import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApiDocHtml } from '../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'sample-apidoc.html');

test('parseApiDocHtml parses sample fixture HTML documentation', () => {
  assert.ok(fs.existsSync(fixturePath), 'Fixture HTML file must exist');

  const { project, endpoints } = parseApiDocHtml(fixturePath);
  assert.ok(project);
  assert.equal(project.title, 'Sample API Documentation');
  assert.equal(endpoints.length, 2);

  const loginEndpoint = endpoints.find(e => e.url === '/v1/clients/web/login');
  assert.ok(loginEndpoint, 'Login endpoint should be present');
  assert.equal(loginEndpoint.method, 'POST');
  assert.equal(loginEndpoint.group, 'Authentication');
  assert.ok(loginEndpoint.body.some(b => b.field === 'email'));
  assert.ok(loginEndpoint.body.some(b => b.field === 'password'));

  const usersEndpoint = endpoints.find(e => e.url === '/v1/users');
  assert.ok(usersEndpoint, 'Users endpoint should be present');
  assert.equal(usersEndpoint.method, 'GET');
  assert.equal(usersEndpoint.permission, 'manage-users');
  assert.ok(usersEndpoint.exampleResponse);
  assert.ok(Array.isArray(usersEndpoint.query));
});
