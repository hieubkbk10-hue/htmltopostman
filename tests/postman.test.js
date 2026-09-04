import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostmanCollection } from '../src/postman.js';

test('buildPostmanCollection formats rich docs and multiple response examples', () => {
  const project = {
    title: 'Test API',
    description: 'Test API description',
  };

  const endpoints = [
    {
      name: 'GetAllUsers',
      title: 'Get All Users',
      group: 'User',
      method: 'GET',
      url: '/v1/users',
      permission: 'Authenticated',
      params: [{ field: 'page', defaultValue: '1', optional: true }],
      exampleResponse: { data: [] },
    },
    {
      name: 'CreateMailboxMailserver',
      title: 'Create Mailbox Mailserver',
      group: 'Mailserver',
      method: 'POST',
      url: '/v1/mailservers/:id/mailboxes',
      permission: "Authenticated ['permissions' => 'manage-mailservers']",
      params: [{ field: 'id', defaultValue: '1', optional: false }],
      body: [
        { field: 'name', type: 'String', optional: false, description: 'Display Name' },
        { field: 'quota', type: 'Number', optional: false, defaultValue: '1024', description: 'MB Quota' },
      ],
      exampleResponse: { data: { id: 1, name: 'Mailbox' } },
    },
  ];

  const liveResponses = new Map();
  liveResponses.set('GetAllUsers', [
    {
      name: 'GET /v1/users - Live Response',
      status: 'OK',
      code: 200,
      body: JSON.stringify({ data: [{ id: 100 }] }),
      header: [{ key: 'content-type', value: 'application/json' }],
    },
  ]);

  const collection = buildPostmanCollection({
    project,
    endpoints,
    baseUrl: 'https://api.test',
    token: 'jwt-token',
    liveResponses,
  });

  const mailboxItem = collection.item.find(i => i.name === 'Mailserver').item[0];
  
  // Verify Markdown Docs
  assert.ok(mailboxItem.request.description.includes('## Create Mailbox Mailserver'));
  assert.ok(mailboxItem.request.description.includes('### 🔒 Phân quyền & Xác thực'));
  assert.ok(mailboxItem.request.description.includes('### 📋 Request Headers'));
  assert.ok(mailboxItem.request.description.includes('### 🎯 Path Parameters'));
  assert.ok(mailboxItem.request.description.includes('### 📦 Request Body'));
  assert.ok(mailboxItem.request.description.includes('#### 💡 Ví dụ Request Body (JSON)'));
  assert.ok(mailboxItem.request.description.includes('### 🎯 Ví dụ Phản hồi'));

  // Verify Multiple Saved Responses (Examples)
  assert.ok(mailboxItem.response.length >= 3, `Expected at least 3 examples, got ${mailboxItem.response.length}`);
  const names = mailboxItem.response.map(r => r.name);
  assert.ok(names.some(n => n.includes('Documentation Example')));
  assert.ok(names.some(n => n.includes('401 Unauthorized')));
  assert.ok(names.some(n => n.includes('422 Unprocessable Entity')));
});
