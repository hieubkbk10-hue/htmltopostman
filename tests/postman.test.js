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

test('buildPostmanCollection generates multi-row individual and combined includes without truncation', () => {
  const project = { title: 'Support API' };
  const endpoints = [
    {
      name: 'GetAllSupportCases',
      title: 'Get All Support Cases',
      group: 'SupportCase',
      method: 'GET',
      url: '/v1/support-cases',
      permission: 'Authenticated',
      exampleResponse: {
        data: [],
        meta: {
          include: ['customer', 'serviceable', 'comments', 'lastComment'],
          pagination: { total: 10 },
        },
      },
    },
    {
      name: 'FindSupportCaseById',
      title: 'Find Support Case by ID',
      group: 'SupportCase',
      method: 'GET',
      url: '/v1/support-cases/:id',
      permission: 'Authenticated',
      params: [{ field: 'id', defaultValue: '1', optional: false }],
      exampleResponse: { data: { id: 1 } },
    },
  ];

  const liveResponses = new Map();
  liveResponses.set('GetAllSupportCases', [
    {
      name: 'GET /v1/support-cases - Live Response',
      status: 'OK',
      code: 200,
      body: JSON.stringify({
        data: [{ id: 1, title: 'Case 1' }],
        meta: {
          include: ['customer', 'serviceable', 'comments', 'lastComment'],
          pagination: { total: 1 },
        },
      }),
    },
    {
      name: 'GET /v1/support-cases?include=customer,serviceable,comments,lastComment - Live Response (Eager Loading)',
      status: 'OK',
      code: 200,
      body: JSON.stringify({
        data: [{
          id: 1,
          customer: { data: { id: 3, name: 'Customer A' } },
          comments: { data: [{ id: 5, body: 'Sample comment' }] },
          lastComment: { data: { id: 5 } },
        }],
      }),
    },
  ]);

  const collection = buildPostmanCollection({
    project,
    endpoints,
    baseUrl: 'https://api.test',
    token: 'jwt-token',
    liveResponses,
  });

  const supportGroup = collection.item.find(i => i.name === 'SupportCase');
  assert.ok(supportGroup, 'SupportCase folder should exist');

  const listEndpoint = supportGroup.item.find(i => i.name === 'Get All Support Cases');
  assert.ok(listEndpoint, 'Get All Support Cases should exist');

  // Verify multi-row includes
  const listIncludeParams = listEndpoint.request.url.query.filter(q => q.key === 'include');
  assert.equal(listIncludeParams.length, 5, 'Should have 1 combined row + 4 individual rows');

  // 1. Combined row
  assert.equal(listIncludeParams[0].value, 'customer,serviceable,comments,lastComment');
  assert.equal(listIncludeParams[0].disabled, true);

  // 2-5. Individual rows
  assert.equal(listIncludeParams[1].value, 'customer');
  assert.equal(listIncludeParams[2].value, 'serviceable');
  assert.equal(listIncludeParams[3].value, 'comments');
  assert.equal(listIncludeParams[4].value, 'lastComment');

  // Verify multiple live responses saved in examples
  assert.ok(listEndpoint.response.length >= 2);
  const respNames = listEndpoint.response.map(r => r.name);
  assert.ok(respNames.some(n => n.includes('Eager Loading')));

  // Verify Detail Endpoint inherits all includes from resource
  const detailEndpoint = supportGroup.item.find(i => i.name === 'Find Support Case by ID');
  assert.ok(detailEndpoint, 'Find Support Case by ID should exist');
  const detailIncludeParams = detailEndpoint.request.url.query.filter(q => q.key === 'include');
  assert.equal(detailIncludeParams.length, 5, 'Detail endpoint should inherit all 5 include rows');
  assert.equal(detailIncludeParams[3].value, 'comments');
  assert.equal(detailIncludeParams[4].value, 'lastComment');
});

