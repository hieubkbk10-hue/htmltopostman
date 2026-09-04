import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, normalizeBaseUrl, cleanHtml, safeJsonParse } from '../src/utils.js';

test('parseArgs parses CLI arguments properly', () => {
  const args = parseArgs([
    '--html', 'path/to/docs.html',
    '--base-url', 'https://api.example.com',
    '--email', 'user@example.com',
    '--password', 'secret',
    '--output', 'postman.json',
    '--patch-limit', '10',
    '--no-live'
  ]);

  assert.equal(args.html, 'path/to/docs.html');
  assert.equal(args.baseUrl, 'https://api.example.com');
  assert.equal(args.email, 'user@example.com');
  assert.equal(args.password, 'secret');
  assert.equal(args.output, 'postman.json');
  assert.equal(args.patchLimit, 10);
  assert.equal(args.noLive, true);
});

test('normalizeBaseUrl ensures protocol and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
  assert.equal(normalizeBaseUrl('https://api.example.com///'), 'https://api.example.com');
});

test('cleanHtml removes HTML tags and decodes entities', () => {
  assert.equal(cleanHtml('<p>Hello &quot;World&quot;</p>'), 'Hello "World"');
});

test('safeJsonParse parses valid json and returns fallback on invalid', () => {
  assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true });
  assert.equal(safeJsonParse('invalid', 'fallback'), 'fallback');
});
