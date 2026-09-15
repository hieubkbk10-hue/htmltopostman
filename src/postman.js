export function buildPostmanCollection({
  project,
  endpoints,
  baseUrl,
  token = '',
  liveResponses = new Map(),
}) {
  const collectionDesc = generateCollectionOverview(project);

  const collection = {
    info: {
      name: project?.title || 'API Documentation',
      _postman_id: buildDeterministicId(project?.title || 'api'),
      description: collectionDesc,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    },
    variable: [
      { key: 'base_url', value: baseUrl || 'http://localhost', type: 'string', description: 'Gốc URL backend (không kèm / ở cuối)' },
      { key: 'token', value: token || '', type: 'string', description: 'Bearer access token — tự cập nhật khi chạy POST Login' },
      { key: 'email', value: 'admin@admin.com', type: 'string', description: 'Tài khoản admin để đăng nhập' },
      { key: 'password', value: 'admin', type: 'string', description: 'Mật khẩu admin để đăng nhập' },
      { key: 'page', value: '1', type: 'string', description: 'Trang phân trang Apiato' },
      { key: 'limit', value: '20', type: 'string', description: 'Số bản ghi mỗi trang (limit=0 lấy toàn bộ)' },
    ],
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            '// Global assertions for every request in this collection.',
            'pm.test("Status is 2xx (success)", function () {',
            '    pm.expect(pm.response.code).to.be.within(200, 299);',
            '});',
            'pm.test("Response time < 3000ms", function () {',
            '    pm.expect(pm.response.responseTime).to.be.below(3000);',
            '});',
            'if (pm.response.headers.get("content-type") && pm.response.headers.get("content-type").indexOf("json") !== -1) {',
            '    var json = pm.response.json();',
            '    pm.test("Body is valid JSON with data/result envelope", function () {',
            '        pm.expect(json).to.be.an("object");',
            '        pm.expect(json).to.have.any.keys("data", "result", "message", "errors");',
            '    });',
            '}',
          ],
        },
      },
    ],
    item: [],
  };

  // Pre-scan endpoints and live responses to index available includes by resource
  const resourceIncludesMap = new Map();
  for (const ep of endpoints) {
    const cleanUrl = (ep.url.startsWith('/') ? ep.url : `/${ep.url}`).split('?')[0];
    const rName = extractResourceName(cleanUrl, ep.group);
    if (!resourceIncludesMap.has(rName)) {
      resourceIncludesMap.set(rName, new Set());
    }
    if (Array.isArray(ep.exampleResponse?.meta?.include)) {
      for (const inc of ep.exampleResponse.meta.include) {
        resourceIncludesMap.get(rName).add(inc);
      }
    }
    const resps = liveResponses.get(ep.name) || [];
    for (const r of resps) {
      if (r && r.body) {
        try {
          const pb = JSON.parse(r.body);
          if (Array.isArray(pb.meta?.include)) {
            for (const inc of pb.meta.include) {
              resourceIncludesMap.get(rName).add(inc);
            }
          }
        } catch {}
      }
    }
  }

  // Group endpoints by groupTitle or group
  const grouped = new Map();
  for (const ep of endpoints) {
    const groupName = ep.groupTitle || ep.group || 'General';
    if (!grouped.has(groupName)) {
      grouped.set(groupName, []);
    }
    grouped.get(groupName).push(ep);
  }

  for (const [groupName, eps] of grouped.entries()) {
    const folder = {
      name: groupName,
      item: eps.map(ep => buildPostmanItem(ep, liveResponses, resourceIncludesMap)),
    };
    collection.item.push(folder);
  }

  return collection;
}

function buildDeterministicId(seed) {
  // Postman tolerates any string for _postman_id; keep it stable across runs.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return `${hex}-${hex}-${hex}-${hex}`;
}

function buildPostmanItem(endpoint, liveResponses, resourceIncludesMap = new Map()) {
  let method = (endpoint.method || 'GET').toUpperCase();
  if (method.includes('/')) {
    method = (Array.isArray(endpoint.body) && endpoint.body.length > 0) ? 'POST' : 'GET';
  }

  const rawUrl = endpoint.url.startsWith('/') ? endpoint.url : `/${endpoint.url}`;
  const cleanPath = rawUrl.split('?')[0];
  const pathSegments = cleanPath.split('/').filter(Boolean);
  const resourceName = extractResourceName(cleanPath, endpoint.group);

  // Extract Path Variables
  const pathVariables = [];
  for (const seg of pathSegments) {
    if (seg.startsWith(':')) {
      const varKey = seg.substring(1);
      const matchedParam = (endpoint.params || []).find(p => p.field === varKey);
      pathVariables.push({
        key: varKey,
        value: matchedParam?.defaultValue || '1',
        description: matchedParam?.description || `Path parameter ${varKey}`,
      });
    }
  }

  // Extract Live Responses if available
  const allLiveResponses = liveResponses.has(endpoint.name)
    ? (liveResponses.get(endpoint.name) || [])
    : [];

  // Auto-discover Apiato Fractal Includes and Pagination from all live responses or doc example
  let availableIncludes = [];
  let isPaginated = false;

  for (const resp of allLiveResponses) {
    if (resp && resp.body) {
      try {
        const parsedBody = JSON.parse(resp.body);
        if (Array.isArray(parsedBody.meta?.include)) {
          for (const inc of parsedBody.meta.include) {
            if (!availableIncludes.includes(inc)) availableIncludes.push(inc);
          }
        }
        if (parsedBody.meta?.pagination) isPaginated = true;
      } catch {}
    }
  }

  if (endpoint.exampleResponse) {
    if (Array.isArray(endpoint.exampleResponse?.meta?.include)) {
      for (const inc of endpoint.exampleResponse.meta.include) {
        if (!availableIncludes.includes(inc)) availableIncludes.push(inc);
      }
    }
    if (endpoint.exampleResponse?.meta?.pagination) isPaginated = true;
  }

  // Cross-inherit includes from resource level if available
  if (resourceIncludesMap && resourceIncludesMap.has(resourceName)) {
    for (const inc of resourceIncludesMap.get(resourceName)) {
      if (!availableIncludes.includes(inc)) availableIncludes.push(inc);
    }
  }

  // Build Comprehensive Query Parameters
  const queryParams = [];
  const allQueryParams = [];
  if (Array.isArray(endpoint.query)) allQueryParams.push(...endpoint.query);
  if (Array.isArray(endpoint.params)) {
    for (const p of endpoint.params) {
      if (!p.field.startsWith(':') && !pathSegments.includes(`:${p.field}`)) {
        if (!allQueryParams.some(q => q.field === p.field)) allQueryParams.push(p);
      }
    }
  }

  const docInclude = allQueryParams.find(q => q.field === 'include');
  if (docInclude && Array.isArray(docInclude.allowedValues)) {
    for (const val of docInclude.allowedValues) {
      const cleanVal = val.replace(/^"|"$/g, '').trim();
      if (cleanVal && !availableIncludes.includes(cleanVal)) availableIncludes.push(cleanVal);
    }
  }

  for (const q of allQueryParams) {
    if (q.field === 'include' && availableIncludes.length > 0) continue;
    let sampleVal = q.defaultValue || '';
    if (!sampleVal && q.allowedValues && q.allowedValues.length > 0) {
      sampleVal = q.allowedValues[0].replace(/^"|"$/g, '');
    }
    if (!sampleVal && q.field.toLowerCase().includes('domain')) sampleVal = 'example.com';
    queryParams.push({
      key: q.field,
      value: sampleVal,
      description: q.description || '',
      disabled: !!q.optional && !q.defaultValue,
    });
  }

  const smart = getResourceSmartQuery(resourceName);
  const isListGet = method === 'GET' && !pathSegments.some(s => s.startsWith(':'));
  const isDetailGet = method === 'GET' && pathSegments.some(s => s.startsWith(':'));

  if (isListGet || isPaginated) {
    if (availableIncludes.length > 0) {
      if (availableIncludes.length > 1) {
        queryParams.push({
          key: 'include',
          value: availableIncludes.join(','),
          description: `Nạp TẤT CẢ ${availableIncludes.length} quan hệ: ${availableIncludes.join(', ')}`,
          disabled: true,
        });
      }
      for (const rel of availableIncludes) {
        queryParams.push({
          key: 'include',
          value: rel,
          description: `Nạp riêng quan hệ: ${rel}`,
          disabled: true,
        });
      }
    }

    const pushIfAbsent = (key, value, description) => {
      if (!queryParams.some(q => q.key === key)) {
        queryParams.push({ key, value, description, disabled: true });
      }
    };

    pushIfAbsent('page', '1', 'Số trang (Apiato Pagination)');
    pushIfAbsent('limit', '20', 'Số lượng bản ghi mỗi trang (Mặc định: 20, truyền limit=0 để lấy toàn bộ)');
    pushIfAbsent('orderBy', smart.orderBy || 'created_at', 'Sắp xếp theo trường (created_at, id, name, expiration_date...)');
    pushIfAbsent('sortedBy', 'desc', 'Chiều sắp xếp: desc (giảm dần / mới nhất) hoặc asc (tăng dần)');
    pushIfAbsent('search', smart.search || 'status:active', 'Tìm kiếm: keyword hoặc field:keyword hoặc field1:kw1;field2:kw2');
    pushIfAbsent('searchFields', smart.searchFields || 'name:like;status:=', 'Toán tử so sánh từng trường: =, !=, >, <, >=, <=, like, in, notin, between');
    pushIfAbsent('searchJoin', 'and', 'Ghép điều kiện tìm kiếm bằng AND (mặc định backend là OR)');
    if (smart.searchDate) pushIfAbsent('searchDate', smart.searchDate, 'Lọc khoảng ngày: start,end hoặc start,end|field_name (YYYY-MM-DD)');
    if (smart.searchNull) pushIfAbsent('searchNull', smart.searchNull, 'Lọc trường rỗng (field) hoặc có giá trị (field:not)');
    if (smart.searchHas) pushIfAbsent('searchHas', smart.searchHas, 'Lọc có quan hệ liên kết (rel) hoặc không có (rel:not)');
    if (smart.searchInclude) pushIfAbsent('searchInclude', smart.searchInclude, 'Lọc theo thuộc tính bảng quan hệ: relation:field,value');
    pushIfAbsent('filter', smart.filter || 'id;name;status', 'Sparse Fieldsets: chỉ trả về các cột cần thiết (phân tách bằng ;)');
    pushIfAbsent('skipCache', 'true', 'Cưỡng chế bỏ qua cache, truy vấn trực tiếp database');
    if (smart.isRandom) pushIfAbsent('isRandom', '1', 'Lấy dữ liệu ngẫu nhiên (widget gợi ý, banner)');
  } else if (isDetailGet) {
    if (availableIncludes.length > 0) {
      if (availableIncludes.length > 1) {
        queryParams.push({
          key: 'include',
          value: availableIncludes.join(','),
          description: `Nạp TẤT CẢ ${availableIncludes.length} quan hệ: ${availableIncludes.join(', ')}`,
          disabled: true,
        });
      }
      for (const rel of availableIncludes) {
        queryParams.push({ key: 'include', value: rel, description: `Nạp riêng quan hệ: ${rel}`, disabled: true });
      }
    }
    if (!queryParams.some(q => q.key === 'filter')) {
      queryParams.push({ key: 'filter', value: smart.filter || 'id;status', description: 'Sparse Fieldsets: chỉ trả về các trường cần thiết', disabled: true });
    }
    if (!queryParams.some(q => q.key === 'skipCache')) {
      queryParams.push({ key: 'skipCache', value: 'true', description: 'Bỏ qua cache máy chủ', disabled: true });
    }
  }

  let fullRawUrl = `{{base_url}}${cleanPath}`;
  const activeQueries = queryParams.filter(q => !q.disabled && q.value);
  if (activeQueries.length > 0) {
    const qs = activeQueries.map(q => `${q.key}=${encodeURIComponent(q.value)}`).join('&');
    fullRawUrl += `?${qs}`;
  }

  // Headers — Authorization now comes from collection-level bearer auth (inherit),
  // so we no longer hardcode it per-request. Accept + Content-Type remain explicit.
  const headers = [{ key: 'Accept', value: 'application/json' }];

  if (Array.isArray(endpoint.headers)) {
    for (const h of endpoint.headers) {
      const hKey = h.key || h.field;
      if (!hKey) continue;
      if (hKey.toLowerCase() !== 'accept' && hKey.toLowerCase() !== 'authorization') {
        headers.push({ key: hKey, value: h.value || h.defaultValue || '', description: h.description });
      }
    }
  }

  // Body Construction with Realistic Defaults
  let body = undefined;
  let bodyObj = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (Array.isArray(endpoint.body) && endpoint.body.length > 0) {
      for (const b of endpoint.body) bodyObj[b.field] = resolveSampleValue(b);
    }
    if (Object.keys(bodyObj).length > 0) {
      headers.push({ key: 'Content-Type', value: 'application/json' });
      body = { mode: 'raw', raw: JSON.stringify(bodyObj, null, 2), options: { raw: { language: 'json' } } };
    }
  }

  // Event Scripts: login auto-sync + per-request status assertion
  const events = [];
  if (cleanPath.includes('/login')) {
    events.push({
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: [
          'if (pm.response.code === 200) {',
          '    var res = pm.response.json();',
          '    var token = res.access_token || res.token || (res.data && (res.data.token || res.data.access_token));',
          '    if (token) {',
          '        pm.collectionVariables.set("token", token);',
          '        console.log("[htmltpostman] Da tu dong cap nhat Bearer token moi vao bien collection token");',
          '    }',
          '}',
        ],
      },
    });
  }

  const request = {
    method,
    header: headers,
    url: {
      raw: fullRawUrl,
      host: ['{{base_url}}'],
      path: pathSegments,
      query: queryParams.length > 0 ? queryParams : undefined,
      variable: pathVariables.length > 0 ? pathVariables : undefined,
    },
    description: generateMarkdownDocumentation(
      endpoint, method, pathVariables, queryParams, headers, bodyObj, allLiveResponses, availableIncludes
    ),
    body,
  };

  // Auth override: public endpoints opt out of bearer inheritance.
  const isPublic = !!endpoint.isPublic || (endpoint.permission && /unauthenticated|none/i.test(endpoint.permission));
  if (isPublic) request.auth = { type: 'noauth' };

  // Saved Responses (Examples)
  const responses = [];

  if (allLiveResponses.length > 0) responses.push(...allLiveResponses);

  if (endpoint.exampleResponse) {
    const parsedDocExample = parseDocExample(endpoint.raw?.success?.examples?.[0]?.content, endpoint.exampleResponse);
    responses.push(buildResponseExample(method, fullRawUrl, pathSegments, queryParams, pathVariables, body, parsedDocExample.code, parsedDocExample.status, parsedDocExample.body, 'Documentation Example'));
  }

  // Real error examples from the documentation (e.g. 400/403) — newly captured
  if (Array.isArray(endpoint.errorExamples)) {
    for (const err of endpoint.errorExamples) {
      if (!err || err.code == null) continue;
      const errBody = typeof err.body === 'object' && err.body !== null ? JSON.stringify(err.body, null, 2) : String(err.body || '{}');
      responses.push(buildResponseExample(method, fullRawUrl, pathSegments, queryParams, pathVariables, body, err.code, err.status || statusText(err.code), errBody, `Doc ${err.code} ${err.status || statusText(err.code)}`));
    }
  }

  if (!isPublic && !responses.some(r => r.code === 401)) {
    responses.push(buildResponseExample(method, fullRawUrl, pathSegments, queryParams, pathVariables, body, 401, 'Unauthorized', JSON.stringify({ message: 'Unauthenticated.' }, null, 2), 'Error Example'));
  }

  if (Object.keys(bodyObj).length > 0 && !responses.some(r => r.code === 422)) {
    const errorDetails = {};
    for (const key of Object.keys(bodyObj).slice(0, 3)) errorDetails[key] = [`The ${key} field is required.`];
    responses.push(buildResponseExample(method, fullRawUrl, pathSegments, queryParams, pathVariables, body, 422, 'Unprocessable Entity', JSON.stringify({ message: 'The given data was invalid.', errors: errorDetails }, null, 2), 'Validation Error'));
  }

  return {
    name: endpoint.title || endpoint.name,
    event: events.length > 0 ? events : undefined,
    request,
    response: responses,
  };
}

function buildResponseExample(method, rawUrl, pathSegments, queryParams, pathVariables, body, code, status, bodyText, nameSuffix) {
  return {
    name: `${code} ${status} - ${nameSuffix}`,
    originalRequest: {
      method,
      header: [{ key: 'Accept', value: 'application/json' }],
      url: {
        raw: rawUrl,
        host: ['{{base_url}}'],
        path: pathSegments,
        query: queryParams.length > 0 ? queryParams : undefined,
        variable: pathVariables.length > 0 ? pathVariables : undefined,
      },
      body,
    },
    status,
    code,
    _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    cookie: [],
    body: bodyText,
  };
}

function statusText(code) {
  const map = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };
  return map[code] || 'Error';
}

function extractResourceName(url, group) {
  const cleanUrl = url.split('?')[0];
  const parts = cleanUrl.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{') && p !== 'v1' && p !== 'api');
  if (parts.length > 0) return parts[0].toLowerCase();
  return (group || 'general').toLowerCase();
}

function getResourceSmartQuery(resourceName) {
  switch (resourceName) {
    case 'users': return { orderBy: 'created_at', search: 'name:admin', searchFields: 'name:like;email:=', searchDate: '2026-01-01,2026-12-31|created_at', searchNull: 'phone:not', filter: 'id;name;email;status' };
    case 'domains': return { orderBy: 'created_at', search: 'domain_name:satek', searchFields: 'domain_name:like;status:=', searchDate: '2026-01-01,2026-12-31|expiration_date', searchNull: 'admin_contact_id:not', filter: 'id;domain_name;domain_ext;status' };
    case 'mailservers': return { orderBy: 'created_at', search: 'domain_name:satek', searchFields: 'domain_name:like;auto_renew:=', searchDate: '2026-03-01,2026-03-31|expiration_date', searchNull: 'dns_configured:not', filter: 'id;domain_name;auto_renew;status' };
    case 'orders': return { orderBy: 'created_at', search: 'status:new', searchFields: 'status:=;payment:=', searchDate: '2026-01-01,2026-12-31|created_at', searchInclude: 'customer:type,vip', filter: 'id;code;status;total;payment' };
    case 'customers': return { orderBy: 'created_at', search: 'status:active', searchFields: 'status:=', searchInclude: 'contacts:type,main', filter: 'id;user_id;balance' };
    case 'products': return { orderBy: 'id', search: 'status:active', searchFields: 'status:=;type:=', isRandom: '1', filter: 'id;name;type;prices' };
    case 'transactions': return { orderBy: 'date', search: 'type:in', searchFields: 'type:=;payment_method:=', searchDate: '2026-01-01,2026-12-31|date', filter: 'id;code;money;type;payment_method' };
    case 'places': return { orderBy: 'code', search: 'name:Hanoi', searchFields: 'name:like;level:=', filter: 'id;name;code;level' };
    case 'diaries': return { orderBy: 'created_at', search: 'type:user', searchHas: 'user', filter: 'id;name;type;created_at' };
    case 'support-cases': return { orderBy: 'created_at', search: 'status:open', searchFields: 'status:=', filter: 'id;title;status;created_at' };
    default: return { orderBy: 'created_at', search: 'status:active', searchFields: 'status:=', filter: 'id;status;created_at' };
  }
}

function resolveSampleValue(field) {
  if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== '') {
    const val = String(field.defaultValue).trim();
    if (val.toLowerCase() === 'true') return true;
    if (val.toLowerCase() === 'false') return false;
    if (val.toLowerCase() === 'null') return null;
    if (/^\d+$/.test(val)) return parseInt(val, 10);
    if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
    return val.replace(/^"|"$/g, '');
  }

  if (Array.isArray(field.allowedValues) && field.allowedValues.length > 0) {
    return field.allowedValues[0].replace(/^"|"$/g, '');
  }

  const name = field.field.toLowerCase();
  const type = (field.type || '').toLowerCase();

  if (name.includes('permission_ids') || name.includes('permissions_ids')) return [1, 2];
  if (name === 'goto') return ['admin@example.com'];
  if (name === 'prices') return [{ price: 100000, period: 1 }];
  if (name === 'items') return [{ product_id: 1, quantity: 1, domain: 'example.com' }];
  if (name === 'files') return ['https://example.com/sample.pdf'];
  if (name.includes('email')) return 'admin@admin.com';
  if (name.includes('password')) return 'Secret123!';
  if (name.includes('phone')) return '0901234567';
  if (name.includes('domain')) return 'example.com';
  if (name.includes('url') || name.includes('link') || name.includes('avatar')) return 'https://api.example.com/avatar.png';
  if (name === 'quota' || name === 'maxquota' || name === 'defquota') return 1024;
  if (name === 'aliases' || name === 'mailboxes') return 5;
  if (name === 'local_part') return 'info';
  if (name.includes('name') || name.includes('title')) return 'Sample Name';
  if (name.includes('description') || name.includes('content') || name.includes('note')) return 'Detailed sample description';
  if (name.includes('date') || name.includes('birthday')) return '2026-09-12';
  if (name === 'status') return 'active';
  if (name.includes('is_') || name.includes('has_') || name === 'auto_renew' || type.includes('bool')) return true;
  if (type.includes('num') || type.includes('int') || type.includes('float') || name.endsWith('_id')) return 1;
  if (type.includes('[]') || type.includes('array')) return [];
  if (type.includes('object')) return {};

  return 'string';
}

function parseDocExample(rawContent, exampleResponse) {
  let code = 200;
  let status = 'OK';
  if (rawContent && typeof rawContent === 'string') {
    const match = rawContent.match(/HTTP\/[\d.]+\s+(\d+)\s*([^\r\n]*)/i);
    if (match) {
      code = parseInt(match[1], 10);
      status = match[2].trim() || (code === 204 ? 'No Content' : (code === 201 ? 'Created' : 'OK'));
    }
  }
  const body = typeof exampleResponse === 'object' && exampleResponse !== null
    ? JSON.stringify(exampleResponse, null, 2)
    : String(exampleResponse || '{}');
  return { code, status, body };
}

function generateCollectionOverview(project) {
  return `# ${project?.title || 'App Name'} - API Documentation & Postman Collection

> Cong cu sinh tu dong **htmltpostman** ket hop **Live Response Capture** va **Dependency Crawler**.
> Backend xay dung tren **Apiato 11.x (Porto SAP / Laravel 9.x)** voi engine **RequestCriteria / Repository Pattern**.

## 1. CACH DUNG NHANH
1. Import file **collection** (tên kết thúc \`.postman_collection.json\`).
2. Import file **environment** (\`.postman_environment.json\`) roi chon environment \`{{envName}}\` o goi tren cung ben trai.
3. Chay request **POST Login** truoc tien — Test Script se tu dong luu \`access_token\` vao bien \`{{token}}\`, moi endpoint khac nhan ngay lap tuc.
4. Collection da dat **Bearer auth o muc collection**; cac request public (login/forgot) tu override sang \`noauth\`.

## 2. THONG SO VAN HANH

| Thong so | Gia tri | Ghi chu |
| :--- | :--- | :--- |
| Accept Header | \`application/json\` | Bat buoc tren 100% request |
| Content-Type | \`application/json\` | Bat buoc khi gui Body |
| Authorization | \`Bearer {{token}}\` | Tu dong qua collection auth + login script |
| Rate Limiting | 1200 req/phut | Theo doi header \`X-RateLimit-Remaining\` |
| Access Token | 365 ngay | Tu dong cap nhat khi chay Login |

## 3. BANG TRA CUU TRUY VAN NHANH (QUERY DECISION MATRIX)

| Nghiep vu | Tham so | Vi du |
| :--- | :--- | :--- |
| Phan trang | \`page\`, \`limit\` | \`/v1/orders?page=1&limit=20\` (limit=0 = het) |
| Sap xep | \`orderBy\`, \`sortedBy\` | \`/v1/orders?orderBy=created_at&sortedBy=desc\` |
| Ngau nhien | \`isRandom\` | \`/v1/products?isRandom=1&limit=4\` |
| Tim kiem chung | \`search\` | \`/v1/mailservers?search=satek\` |
| Tim theo cot | \`search\` | \`/v1/domains?search=domain_name:satek.vn\` |
| Toan tu so sanh | \`searchFields\` | \`/v1/products?search=prices:100000&searchFields=prices:>=\` |
| Ghop AND | \`searchJoin\` | \`/v1/users?search=name:a;status:active&searchJoin=and\` |
| Loc ngay | \`searchDate\` | \`/v1/orders?searchDate=2026-01-01,2026-12-31|created_at\` |
| Loc rong/co du lieu | \`searchNull\` | \`/v1/users?searchNull=phone:not\` |
| Loc co quan he | \`searchHas\` | \`/v1/diaries?searchHas=user\` |
| Loc theo bang quan he | \`searchInclude\` | \`/v1/orders?searchInclude=customer:type,vip\` |
| Eager Loading | \`include\` | \`/v1/domains?include=product,customer\` |
| Sparse Fieldset | \`filter\` | \`/v1/customers?filter=id;user_id;balance\` |
| Bo qua cache | \`skipCache\` | \`/v1/mailservers?skipCache=true\` |

## 4. QUY UOC KY TU PHAN CACH
- Dấu chấm phẩy \`;\`: ngan cach cac truong doc lap (search, searchFields, searchNull, filter).
- Dấu hai chấm \`:\`: ngan cach ten truong va gia tri/toan tu (\`name:satek\`, \`status:=\`, \`phone:not\`).
- Dấu phẩy \`,\`: ngan cach danh sach quan he (include) hoac khoang ngay (searchDate).
- Dấu gạch đứng \`|\`: chi dinh ten cot ngay tuy chinh (\`start,end|expiration_date\`).
`;
}

function generateMarkdownDocumentation(
  endpoint, method, pathVariables, queryParams, headers, bodyObj,
  allLiveResponses = [], availableIncludes = []
) {
  const parts = [];

  parts.push(`## ${endpoint.title || endpoint.name}`);
  parts.push(`> \`${method}\` \`${endpoint.url}\`\n`);

  const metaBits = [];
  if (endpoint.version) metaBits.push(`**Version:** \`${endpoint.version}\``);
  if (endpoint.deprecated) metaBits.push(`**[DEPRECATED]**`);
  if (endpoint.filename) metaBits.push(`**Source:** \`${endpoint.filename}\``);
  if (metaBits.length > 0) { parts.push(metaBits.join('  |  ')); parts.push(''); }

  if (endpoint.description && endpoint.description.trim()) {
    parts.push(`### 📝 Mô tả nghiệp vụ`);
    parts.push(endpoint.description.trim());
    parts.push('');
  }

  parts.push(`### 🔒 Phân quyền & Xác thực`);
  const isPublic = !!endpoint.isPublic || (endpoint.permission && /unauthenticated|none/i.test(endpoint.permission));
  parts.push(`- **Trạng thái:** ${isPublic ? '🟢 Public (không cần đăng nhập)' : '🔴 Bắt buộc Bearer Token (Authenticated)'}`);
  if (endpoint.permission) parts.push(`- **Quyền (Apiato Permission):** \`${endpoint.permission}\``);
  parts.push('');

  if (headers && headers.length > 0) {
    parts.push(`### 📋 Request Headers`);
    parts.push(`| Header | Giá trị | Mô tả |`);
    parts.push(`| :--- | :--- | :--- |`);
    for (const h of headers) parts.push(`| \`${h.key}\` | \`${h.value || '-'}\` | ${h.description || '-'} |`);
    parts.push('');
  }

  if (pathVariables && pathVariables.length > 0) {
    parts.push(`### 🎯 Path Parameters`);
    parts.push(`| Tham số | Kiểu | Bắt buộc | Mô tả |`);
    parts.push(`| :--- | :---: | :---: | :--- |`);
    for (const pv of pathVariables) parts.push(`| \`:${pv.key}\` | \`Number\` | **Có** | ${pv.description || '-'} |`);
    parts.push('');
  }

  if (queryParams && queryParams.length > 0) {
    parts.push(`### 🔍 Query Parameters (Apiato Criteria)`);
    parts.push(`| Tham số | Bắt buộc | Giá trị mẫu | Mô tả |`);
    parts.push(`| :--- | :---: | :--- | :--- |`);
    for (const qp of queryParams) {
      const isReq = qp.disabled ? 'Tùy chọn' : '**Bắt buộc**';
      parts.push(`| \`${qp.key}\` | ${isReq} | \`${qp.value || '-'}\` | ${qp.description || '-'} |`);
    }
    parts.push('');
  }

  if (Array.isArray(endpoint.body) && endpoint.body.length > 0) {
    parts.push(`### 📦 Request Body`);
    parts.push(`| Trường | Kiểu | Bắt buộc | Giá trị mẫu | Mô tả |`);
    parts.push(`| :--- | :---: | :---: | :--- | :--- |`);
    for (const b of endpoint.body) {
      const isReq = b.optional ? 'Không' : '**Có**';
      const sv = bodyObj[b.field] !== undefined ? (typeof bodyObj[b.field] === 'object' ? JSON.stringify(bodyObj[b.field]) : String(bodyObj[b.field])) : '-';
      parts.push(`| \`${b.field}\` | \`${b.type || 'String'}\` | ${isReq} | \`${sv}\` | ${b.description || '-'} |`);
    }
    parts.push('');
    parts.push(`#### 💡 Ví dụ Request Body (JSON)`);
    parts.push('```json');
    parts.push(JSON.stringify(bodyObj, null, 2));
    parts.push('```\n');
  }

  // Response fields table (newly extracted from success.fields when present)
  if (Array.isArray(endpoint.responseFields) && endpoint.responseFields.length > 0) {
    parts.push(`### 🧱 Cấu trúc Response (fields)`);
    parts.push(`| Trường | Kiểu | Mô tả |`);
    parts.push(`| :--- | :---: | :--- |`);
    for (const f of endpoint.responseFields) parts.push(`| \`${f.field}\` | \`${f.type}\` | ${f.description || '-'} |`);
    parts.push('');
  }

  if (availableIncludes && availableIncludes.length > 0) {
    parts.push(`### 🧬 Quan hệ lồng ghép (Fractal Eager Loading)`);
    parts.push(`Endpoint hỗ trợ \`?include=\`. Các dòng include đã có sẵn trong tab **Params** (đang tắt; tick checkbox để dùng):`);
    parts.push(`- **Tất cả (${availableIncludes.length}):** ${availableIncludes.map(r => `\`${r}\``).join(', ')}`);
    if (availableIncludes.length > 1) parts.push(`- **Nạp đồng thời:** \`?include=${availableIncludes.join(',')}\``);
    parts.push(`- **Nạp từng quan hệ:** ${availableIncludes.map(r => `\`?include=${r}\``).join(', ')}\n`);
  }

  parts.push(`### 🎯 Ví dụ Phản hồi (Response Examples)\n`);

  if (allLiveResponses && allLiveResponses.length > 0) {
    for (const liveResp of allLiveResponses) {
      parts.push(`#### ✅ Live Response từ Server (${liveResp.code} ${liveResp.status})`);
      parts.push('```json');
      parts.push(liveResp.body || '{}');
      parts.push('```\n');
    }
  }

  if (endpoint.exampleResponse) {
    const docParsed = parseDocExample(endpoint.raw?.success?.examples?.[0]?.content, endpoint.exampleResponse);
    parts.push(`#### 📄 Phản hồi mẫu từ Tài liệu ApiDoc (${docParsed.code} ${docParsed.status})`);
    parts.push('```json');
    parts.push(docParsed.body);
    parts.push('```\n');
  }

  return parts.join('\n');
}

export function buildPostmanEnvironment({ project, baseUrl, token = '', email = 'admin@admin.com', password = 'admin' }) {
  const envName = `${(project?.title || 'api').replace(/[^a-zA-Z0-9]+/g, ' ').trim()} Env` || 'htmltpostman Env';
  return {
    id: buildDeterministicId(envName),
    name: envName,
    values: [
      { key: 'base_url', value: baseUrl || '', type: 'default', enabled: true },
      { key: 'token', value: token || '', type: 'secret', enabled: true },
      { key: 'email', value: email, type: 'default', enabled: true },
      { key: 'password', value: password, type: 'secret', enabled: true },
      { key: 'page', value: '1', type: 'default', enabled: true },
      { key: 'limit', value: '20', type: 'default', enabled: true },
    ],
    _postman_exported_using: 'htmltpostman',
  };
}
