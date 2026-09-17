import test from 'node:test';
import assert from 'node:assert/strict';
import { diffEndpoints, buildChangelogJson, buildChangelogHtml } from '../src/diff.js';

const endpoint = (overrides = {}) => ({
  name: 'Users', title: 'Danh sách người dùng', method: 'GET', url: '/v1/users',
  description: 'Quản lý người dùng', group: 'Users', groupTitle: 'Users',
  params: [], query: [], body: [], responseFields: [], isPublic: false,
  permission: 'Authenticated', deprecated: false, ...overrides,
});

test('diffEndpoints classifies removed and added endpoints', () => {
  const result = diffEndpoints([endpoint(), endpoint({ name: 'Old', url: '/v1/old' })], [endpoint(), endpoint({ name: 'New', url: '/v1/new' })]);
  assert.equal(result.summary.breaking, 1);
  assert.equal(result.summary.added, 1);
  assert.equal(result.breaking[0].type, 'removed');
});

test('diffEndpoints detects method and required field changes as breaking', () => {
  const result = diffEndpoints(
    [endpoint({ method: 'GET', body: [{ field: 'name', type: 'String', optional: true }] })],
    [endpoint({ method: 'POST', body: [{ field: 'name', type: 'String', optional: false }] })],
  );
  assert.equal(result.summary.breaking, 1);
  assert.ok(result.breaking[0].changes.some(change => change.field === 'method'));
});

test('changelog HTML preserves Vietnamese text and escapes markup', () => {
  const diff = diffEndpoints([endpoint()], [endpoint({ description: 'Mô tả mới <script>' })]);
  const changelog = buildChangelogJson({ oldFile: 'cũ.html', newFile: 'mới.html', oldProject: { title: 'API cũ' }, newProject: { title: 'API mới' }, oldCount: 1, newCount: 1, oldFramework: 'Laravel 9.x', framework: 'Laravel 11.x', oldDate: '2026-09-16', currentDate: '2026-09-17', diff });
  assert.equal(changelog.old.date, '2026-09-16');
  assert.equal(changelog.current.date, '2026-09-17');
  const html = buildChangelogHtml(changelog);
  assert.match(html, /Mô tả mới/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
