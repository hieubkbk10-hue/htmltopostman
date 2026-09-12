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
      description: collectionDesc,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      {
        key: 'base_url',
        value: baseUrl || 'http://localhost',
        type: 'string',
      },
      {
        key: 'token',
        value: token || '',
        type: 'string',
      },
      {
        key: 'email',
        value: 'admin@admin.com',
        type: 'string',
      },
      {
        key: 'password',
        value: 'admin',
        type: 'string',
      },
      {
        key: 'page',
        value: '1',
        type: 'string',
      },
      {
        key: 'limit',
        value: '20',
        type: 'string',
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
  const liveRespItem = allLiveResponses[0] || null;

  // Auto-discover Apiato Fractal Includes and Pagination from all live responses or doc example
  let availableIncludes = [];
  let isPaginated = false;

  for (const resp of allLiveResponses) {
    if (resp && resp.body) {
      try {
        const parsedBody = JSON.parse(resp.body);
        if (Array.isArray(parsedBody.meta?.include)) {
          for (const inc of parsedBody.meta.include) {
            if (!availableIncludes.includes(inc)) {
              availableIncludes.push(inc);
            }
          }
        }
        if (parsedBody.meta?.pagination) {
          isPaginated = true;
        }
      } catch {}
    }
  }

  if (endpoint.exampleResponse) {
    if (Array.isArray(endpoint.exampleResponse?.meta?.include)) {
      for (const inc of endpoint.exampleResponse.meta.include) {
        if (!availableIncludes.includes(inc)) {
          availableIncludes.push(inc);
        }
      }
    }
    if (endpoint.exampleResponse?.meta?.pagination) {
      isPaginated = true;
    }
  }

  // Cross-inherit includes from resource level if available
  if (resourceIncludesMap && resourceIncludesMap.has(resourceName)) {
    for (const inc of resourceIncludesMap.get(resourceName)) {
      if (!availableIncludes.includes(inc)) {
        availableIncludes.push(inc);
      }
    }
  }

  // Build Comprehensive Query Parameters
  const queryParams = [];
  const allQueryParams = [];
  if (Array.isArray(endpoint.query)) {
    allQueryParams.push(...endpoint.query);
  }
  if (Array.isArray(endpoint.params)) {
    for (const p of endpoint.params) {
      if (!p.field.startsWith(':') && !pathSegments.includes(`:${p.field}`)) {
        if (!allQueryParams.some(q => q.field === p.field)) {
          allQueryParams.push(p);
        }
      }
    }
  }

  // Also check if documentation params/query had allowedValues for include
  const docInclude = allQueryParams.find(q => q.field === 'include');
  if (docInclude && Array.isArray(docInclude.allowedValues)) {
    for (const val of docInclude.allowedValues) {
      const cleanVal = val.replace(/^"|"$/g, '').trim();
      if (cleanVal && !availableIncludes.includes(cleanVal)) {
        availableIncludes.push(cleanVal);
      }
    }
  }

  // 1. Existing Query Parameters from documentation
  for (const q of allQueryParams) {
    // If we have auto-discovered availableIncludes, don't output a generic empty include row
    if (q.field === 'include' && availableIncludes.length > 0) {
      continue;
    }
    let sampleVal = q.defaultValue || '';
    if (!sampleVal && q.allowedValues && q.allowedValues.length > 0) {
      sampleVal = q.allowedValues[0].replace(/^"|"$/g, '');
    }
    if (!sampleVal && q.field.toLowerCase().includes('domain')) {
      sampleVal = 'example.com';
    }
    queryParams.push({
      key: q.field,
      value: sampleVal,
      description: q.description || '',
      disabled: !!q.optional && !q.defaultValue,
    });
  }

  // 2. Apiato Smart Query Parameters Toolkit
  const smart = getResourceSmartQuery(resourceName);
  const isListGet = method === 'GET' && !pathSegments.some(s => s.startsWith(':'));
  const isDetailGet = method === 'GET' && pathSegments.some(s => s.startsWith(':'));

  if (isListGet || isPaginated) {
    // Eager Loading: Multiple include rows for maximum dev convenience
    if (availableIncludes.length > 0) {
      // 1. Combined line with ALL available relations
      if (availableIncludes.length > 1) {
        queryParams.push({
          key: 'include',
          value: availableIncludes.join(','),
          description: `⚡ Nạp TẤT CẢ ${availableIncludes.length} quan hệ: ${availableIncludes.join(', ')}`,
          disabled: true,
        });
      }

      // 2. Individual line for EACH relation
      for (const rel of availableIncludes) {
        queryParams.push({
          key: 'include',
          value: rel,
          description: `🔗 Nạp riêng quan hệ: ${rel}`,
          disabled: true,
        });
      }
    }

    // Pagination: page & limit
    if (!queryParams.some(q => q.key === 'page')) {
      queryParams.push({
        key: 'page',
        value: '1',
        description: 'Số trang (Apiato Pagination)',
        disabled: true,
      });
    }
    if (!queryParams.some(q => q.key === 'limit')) {
      queryParams.push({
        key: 'limit',
        value: '20',
        description: 'Số lượng bản ghi mỗi trang (Mặc định: 20, truyền limit=0 để lấy toàn bộ)',
        disabled: true,
      });
    }

    // Sorting: orderBy & sortedBy
    if (!queryParams.some(q => q.key === 'orderBy')) {
      queryParams.push({
        key: 'orderBy',
        value: smart.orderBy || 'created_at',
        description: 'Sắp xếp theo trường (created_at, id, name, expiration_date...)',
        disabled: true,
      });
    }
    if (!queryParams.some(q => q.key === 'sortedBy')) {
      queryParams.push({
        key: 'sortedBy',
        value: 'desc',
        description: 'Chiều sắp xếp: desc (giảm dần / mới nhất) hoặc asc (tăng dần)',
        disabled: true,
      });
    }

    // Searching: search, searchFields, searchJoin
    if (!queryParams.some(q => q.key === 'search')) {
      queryParams.push({
        key: 'search',
        value: smart.search || 'status:active',
        description: 'Tìm kiếm: keyword hoặc field:keyword hoặc field1:kw1;field2:kw2',
        disabled: true,
      });
    }
    if (!queryParams.some(q => q.key === 'searchFields')) {
      queryParams.push({
        key: 'searchFields',
        value: smart.searchFields || 'name:like;status:=',
        description: 'Chỉ định toán tử so sánh cho từng trường: =, !=, >, <, >=, <=, like, in, notin, between',
        disabled: true,
      });
    }
    if (!queryParams.some(q => q.key === 'searchJoin')) {
      queryParams.push({
        key: 'searchJoin',
        value: 'and',
        description: 'Ghép nối điều kiện tìm kiếm bằng AND (mặc định backend là OR)',
        disabled: true,
      });
    }

    // Advanced criteria: searchDate, searchNull, searchHas, searchInclude
    if (smart.searchDate && !queryParams.some(q => q.key === 'searchDate')) {
      queryParams.push({
        key: 'searchDate',
        value: smart.searchDate,
        description: 'Lọc khoảng ngày: start,end hoặc start,end|field_name (Định dạng YYYY-MM-DD)',
        disabled: true,
      });
    }
    if (smart.searchNull && !queryParams.some(q => q.key === 'searchNull')) {
      queryParams.push({
        key: 'searchNull',
        value: smart.searchNull,
        description: 'Lọc trường rỗng (IS NULL: field) hoặc có giá trị (IS NOT NULL: field:not)',
        disabled: true,
      });
    }
    if (smart.searchHas && !queryParams.some(q => q.key === 'searchHas')) {
      queryParams.push({
        key: 'searchHas',
        value: smart.searchHas,
        description: 'Lọc có quan hệ liên kết (WHERE HAS: rel) hoặc không có (rel:not)',
        disabled: true,
      });
    }
    if (smart.searchInclude && !queryParams.some(q => q.key === 'searchInclude')) {
      queryParams.push({
        key: 'searchInclude',
        value: smart.searchInclude,
        description: 'Lọc theo thuộc tính của bảng quan hệ: relation:field,value',
        disabled: true,
      });
    }

    // Sparse Fieldsets: filter
    if (!queryParams.some(q => q.key === 'filter')) {
      queryParams.push({
        key: 'filter',
        value: smart.filter || 'id;name;status',
        description: 'Sparse Fieldsets: chỉ trả về các cột cần thiết (ngăn cách bằng dấu chấm phẩy ;)',
        disabled: true,
      });
    }

    // Cache bypass: skipCache
    if (!queryParams.some(q => q.key === 'skipCache')) {
      queryParams.push({
        key: 'skipCache',
        value: 'true',
        description: 'Cưỡng chế bỏ qua Redis/Memory cache, truy vấn dữ liệu trực tiếp từ database',
        disabled: true,
      });
    }

    // Random: isRandom
    if (smart.isRandom && !queryParams.some(q => q.key === 'isRandom')) {
      queryParams.push({
        key: 'isRandom',
        value: '1',
        description: 'Lấy dữ liệu ngẫu nhiên (phù hợp widget gợi ý, banner)',
        disabled: true,
      });
    }
  } else if (isDetailGet) {
    // Detail GET endpoints also support include, filter, skipCache in Apiato
    if (availableIncludes.length > 0) {
      if (availableIncludes.length > 1) {
        queryParams.push({
          key: 'include',
          value: availableIncludes.join(','),
          description: `⚡ Nạp TẤT CẢ ${availableIncludes.length} quan hệ: ${availableIncludes.join(', ')}`,
          disabled: true,
        });
      }
      for (const rel of availableIncludes) {
        queryParams.push({
          key: 'include',
          value: rel,
          description: `🔗 Nạp riêng quan hệ: ${rel}`,
          disabled: true,
        });
      }
    }
    if (!queryParams.some(q => q.key === 'filter')) {
      queryParams.push({
        key: 'filter',
        value: smart.filter || 'id;status',
        description: 'Sparse Fieldsets: chỉ trả về các trường cần thiết',
        disabled: true,
      });
    }
    if (!queryParams.some(q => q.key === 'skipCache')) {
      queryParams.push({
        key: 'skipCache',
        value: 'true',
        description: 'Bỏ qua cache máy chủ',
        disabled: true,
      });
    }
  }

  // Build fullRawUrl with active query parameters if any
  let fullRawUrl = `{{base_url}}${cleanPath}`;
  const activeQueries = queryParams.filter(q => !q.disabled && q.value);
  if (activeQueries.length > 0) {
    const qs = activeQueries.map(q => `${q.key}=${encodeURIComponent(q.value)}`).join('&');
    fullRawUrl += `?${qs}`;
  }

  // Headers
  const headers = [];
  headers.push({
    key: 'Accept',
    value: 'application/json',
  });

  const isUnauthenticated = endpoint.permission && /unauthenticated|none/i.test(endpoint.permission);
  if (!isUnauthenticated) {
    headers.push({
      key: 'Authorization',
      value: 'Bearer {{token}}',
    });
  }

  if (Array.isArray(endpoint.headers)) {
    for (const h of endpoint.headers) {
      if (h.key.toLowerCase() !== 'accept' && h.key.toLowerCase() !== 'authorization') {
        headers.push({
          key: h.key,
          value: h.value,
          description: h.description,
        });
      }
    }
  }

  // Body Construction with Realistic Defaults
  let body = undefined;
  let bodyObj = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (Array.isArray(endpoint.body) && endpoint.body.length > 0) {
      for (const b of endpoint.body) {
        bodyObj[b.field] = resolveSampleValue(b);
      }
    }

    if (Object.keys(bodyObj).length > 0) {
      headers.push({
        key: 'Content-Type',
        value: 'application/json',
      });

      body = {
        mode: 'raw',
        raw: JSON.stringify(bodyObj, null, 2),
        options: {
          raw: {
            language: 'json',
          },
        },
      };
    }
  }

  // Event Script for Login Auto-Sync
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
          '        console.log("🔑 [htmltpostman] Đã tự động cập nhật Bearer token mới vào biến collection \'token\'!");',
          '    }',
          '}',
        ],
      },
    });
  }

  // Generate Rich Markdown Documentation for Postman Docs Tab
  const markdownDocs = generateMarkdownDocumentation(
    endpoint,
    method,
    pathVariables,
    queryParams,
    headers,
    bodyObj,
    allLiveResponses,
    availableIncludes
  );

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
    description: markdownDocs,
    body,
  };

  // Saved Responses (Examples)
  const responses = [];

  // 1. Live Captured Responses (Base & Eager Loaded Live Responses)
  if (allLiveResponses.length > 0) {
    responses.push(...allLiveResponses);
  }

  // 2. Documentation Success Response (from ApiDoc)
  if (endpoint.exampleResponse) {
    const parsedDocExample = parseDocExample(endpoint.raw?.success?.examples?.[0]?.content, endpoint.exampleResponse);
    responses.push({
      name: `${parsedDocExample.code} ${parsedDocExample.status} - Documentation Example`,
      originalRequest: {
        method,
        header: headers,
        url: {
          raw: fullRawUrl,
          host: ['{{base_url}}'],
          path: pathSegments,
          query: queryParams.length > 0 ? queryParams : undefined,
          variable: pathVariables.length > 0 ? pathVariables : undefined,
        },
        body,
      },
      status: parsedDocExample.status,
      code: parsedDocExample.code,
      _postman_previewlanguage: 'json',
      header: [
        { key: 'Content-Type', value: 'application/json' },
      ],
      cookie: [],
      body: parsedDocExample.body,
    });
  }

  // 3. Standard 401 Unauthorized Error Example (if endpoint requires auth)
  if (!isUnauthenticated) {
    responses.push({
      name: '401 Unauthorized - Error Example',
      originalRequest: {
        method,
        header: headers,
        url: {
          raw: fullRawUrl,
          host: ['{{base_url}}'],
          path: pathSegments,
        },
        body,
      },
      status: 'Unauthorized',
      code: 401,
      _postman_previewlanguage: 'json',
      header: [
        { key: 'Content-Type', value: 'application/json' },
      ],
      cookie: [],
      body: JSON.stringify({ message: 'Unauthenticated.' }, null, 2),
    });
  }

  // 4. Standard 422 Validation Error Example (if endpoint has request body)
  if (Object.keys(bodyObj).length > 0) {
    const errorDetails = {};
    for (const key of Object.keys(bodyObj).slice(0, 3)) {
      errorDetails[key] = [`The ${key} field is required.`];
    }
    responses.push({
      name: '422 Unprocessable Entity - Validation Error',
      originalRequest: {
        method,
        header: headers,
        url: {
          raw: fullRawUrl,
          host: ['{{base_url}}'],
          path: pathSegments,
        },
        body,
      },
      status: 'Unprocessable Entity',
      code: 422,
      _postman_previewlanguage: 'json',
      header: [
        { key: 'Content-Type', value: 'application/json' },
      ],
      cookie: [],
      body: JSON.stringify({
        message: 'The given data was invalid.',
        errors: errorDetails,
      }, null, 2),
    });
  }

  return {
    name: endpoint.title || endpoint.name,
    event: events.length > 0 ? events : undefined,
    request,
    response: responses,
  };
}

function extractResourceName(url, group) {
  const cleanUrl = url.split('?')[0];
  const parts = cleanUrl.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{') && p !== 'v1' && p !== 'api');
  if (parts.length > 0) {
    return parts[0].toLowerCase();
  }
  return (group || 'general').toLowerCase();
}

function getResourceSmartQuery(resourceName) {
  switch (resourceName) {
    case 'users':
      return {
        orderBy: 'created_at',
        search: 'name:admin',
        searchFields: 'name:like;email:=',
        searchDate: '2026-01-01,2026-12-31|created_at',
        searchNull: 'phone:not',
        filter: 'id;name;email;status',
      };
    case 'domains':
      return {
        orderBy: 'created_at',
        search: 'domain_name:satek',
        searchFields: 'domain_name:like;status:=',
        searchDate: '2026-01-01,2026-12-31|expiration_date',
        searchNull: 'admin_contact_id:not',
        filter: 'id;domain_name;domain_ext;status',
      };
    case 'mailservers':
      return {
        orderBy: 'created_at',
        search: 'domain_name:satek',
        searchFields: 'domain_name:like;auto_renew:=',
        searchDate: '2026-03-01,2026-03-31|expiration_date',
        searchNull: 'dns_configured:not',
        filter: 'id;domain_name;auto_renew;status',
      };
    case 'orders':
      return {
        orderBy: 'created_at',
        search: 'status:new',
        searchFields: 'status:=;payment:=',
        searchDate: '2026-01-01,2026-12-31|created_at',
        searchInclude: 'customer:type,vip',
        filter: 'id;code;status;total;payment',
      };
    case 'customers':
      return {
        orderBy: 'created_at',
        search: 'status:active',
        searchFields: 'status:=',
        searchInclude: 'contacts:type,main',
        filter: 'id;user_id;balance',
      };
    case 'products':
      return {
        orderBy: 'id',
        search: 'status:active',
        searchFields: 'status:=;type:=',
        isRandom: '1',
        filter: 'id;name;type;prices',
      };
    case 'transactions':
      return {
        orderBy: 'date',
        search: 'type:in',
        searchFields: 'type:=;payment_method:=',
        searchDate: '2026-01-01,2026-12-31|date',
        filter: 'id;code;money;type;payment_method',
      };
    case 'places':
      return {
        orderBy: 'code',
        search: 'name:Hà Nội',
        searchFields: 'name:like;level:=',
        filter: 'id;name;code;level',
      };
    case 'diaries':
      return {
        orderBy: 'created_at',
        search: 'type:user',
        searchHas: 'user',
        filter: 'id;name;type;created_at',
      };
    case 'support-cases':
      return {
        orderBy: 'created_at',
        search: 'status:open',
        searchFields: 'status:=',
        filter: 'id;title;status;created_at',
      };
    default:
      return {
        orderBy: 'created_at',
        search: 'status:active',
        searchFields: 'status:=',
        filter: 'id;status;created_at',
      };
  }
}

function resolveSampleValue(field) {
  if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== '') {
    const val = field.defaultValue.trim();
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

  // Smart heuristic defaults based on field name and type
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

> [!NOTE]
> Bộ sưu tập Postman này được sinh tự động bởi công cụ **htmltpostman** kết hợp cơ chế **Live Response Capture** và **Dependency Crawler**.
> Hệ thống backend xây dựng trên nền tảng **Apiato 11.x (Porto SAP / Laravel 9.x)**, tích hợp bộ engine **RequestCriteria / Repository Pattern** siêu mạnh mẽ.

---

## ⚡ 1. THÔNG SỐ VẬN HÀNH HỆ THỐNG

| Thông số | Giá trị chuẩn | Ghi chú vận hành |
| :--- | :--- | :--- |
| **Accept Header** | \`application/json\` | **Bắt buộc** gửi kèm trên 100% các request |
| **Content-Type** | \`application/json\` | Bắt buộc gửi khi truyền Body payload |
| **Authorization** | \`Bearer {{token}}\` | Bắt buộc đối với các endpoint yêu cầu xác thực |
| **Rate Limiting** | **1200 requests / phút** | Kiểm tra header: \`X-RateLimit-Limit\` & \`X-RateLimit-Remaining\` |
| **Thời hạn Access Token** | **365 ngày** (525.600 phút) | Tự động cập nhật qua Script đăng nhập |
| **Thời hạn Refresh Token** | **400 ngày** (576.000 phút) | Dùng để làm mới khi Access Token hết hạn |

> [!TIP]
> **TÍNH NĂNG AUTO-SYNC TOKEN ĐỘC QUYỀN:**
> Khi bạn nhấn **Send** tại request \`POST Login\` (\`/v1/clients/web/login\`), Postman Test Script sẽ **tự động bóc tách token và lưu đè vào biến Collection \`{{token}}\`**.
> Toàn bộ 89 endpoint còn lại sẽ tự động nhận token mới ngay lập tức mà không cần copy/paste thủ công!

---

## 🔍 2. BẢNG TRA CỨU TRUY VẤN NHANH (QUERY DECISION MATRIX)

| Tình huống / Nghiệp vụ | Tham số | Cú pháp chuẩn | Ví dụ thực tế |
| :--- | :--- | :--- | :--- |
| **Phân trang danh sách** | \`page\`, \`limit\` | \`page=1&limit=20\` | \`/v1/orders?page=1&limit=20\` (truyền \`limit=0\` để lấy tất cả) |
| **Sắp xếp thứ tự** | \`orderBy\`, \`sortedBy\` | \`orderBy=created_at&sortedBy=desc\` | \`/v1/orders?orderBy=created_at&sortedBy=desc\` |
| **Lấy ngẫu nhiên** | \`isRandom\` | \`isRandom=1\` | \`/v1/products?isRandom=1&limit=4\` |
| **Tìm kiếm từ khóa chung** | \`search\` | \`search=keyword\` | \`/v1/mailservers?search=satek\` |
| **Tìm kiếm theo cột** | \`search\` | \`search=field:keyword\` | \`/v1/domains?search=domain_name:satek.vn\` |
| **Tìm kiếm nhiều cột kết hợp** | \`search\` | \`search=field1:kw1;field2:kw2\` | \`/v1/users?search=name:admin;status:active\` |
| **Chỉ định toán tử so sánh** | \`searchFields\` | \`searchFields=field:operator\` | \`/v1/products?search=prices:100000&searchFields=prices:>=\` |
| **Ghép nối điều kiện bằng AND** | \`searchJoin\` | \`searchJoin=and\` | \`/v1/users?search=name:a;status:active&searchJoin=and\` |
| **Lọc khoảng ngày (Between)** | \`searchDate\` | \`searchDate=start,end\|field\` | \`/v1/orders?searchDate=2026-01-01,2026-12-31\|created_at\` |
| **Lọc trường rỗng / có dữ liệu** | \`searchNull\` | \`searchNull=field:not\` | \`/v1/users?searchNull=phone:not\` (IS NOT NULL) |
| **Lọc có/không có quan hệ** | \`searchHas\` | \`searchHas=relation\` | \`/v1/diaries?searchHas=user\` (WHERE HAS user) |
| **Lọc theo bảng quan hệ** | \`searchInclude\` | \`searchInclude=rel:field,val\` | \`/v1/orders?searchInclude=customer:type,vip\` |
| **Tải kèm quan hệ (Eager Loading)** | \`include\` | \`include=rel1,rel2\` | \`/v1/domains?include=product,customer\` |
| **Thu hẹp cột trả về (Sparse Field)** | \`filter\` | \`filter=id;name;status\` | \`/v1/customers?filter=id;user_id;balance\` |
| **Bỏ qua Cache máy chủ** | \`skipCache\` | \`skipCache=true\` | \`/v1/mailservers?skipCache=true\` |

---

## 📐 3. QUY ƯỚC KÝ TỰ PHÂN CÁCH (DELIMITERS)

- Dấu chấm phẩy \`;\` : Ngăn cách giữa các trường độc lập trong \`search\`, \`searchFields\`, \`searchNull\`, \`filter\`.
- Dấu hai chấm \`:\` : Ngăn cách tên trường với giá trị hoặc toán tử (\`name:satek\`, \`status:=\`, \`phone:not\`).
- Dấu phẩy \`,\` : Ngăn cách danh sách quan hệ (\`include=product,customer\`) hoặc khoảng ngày (\`searchDate=2026-01-01,2026-12-31\`).
- Dấu gạch đứng \`|\` : Chỉ định tên cột ngày tùy chỉnh (\`start,end|expiration_date\`).
`;
}

function generateMarkdownDocumentation(
  endpoint,
  method,
  pathVariables,
  queryParams,
  headers,
  bodyObj,
  allLiveResponses = [],
  availableIncludes = []
) {
  const parts = [];

  // 1. Header & Title
  parts.push(`## ${endpoint.title || endpoint.name}`);
  parts.push(`> \`${method}\` \`${endpoint.url}\`\n`);

  // 2. Overview / Description
  if (endpoint.description && endpoint.description.trim()) {
    parts.push(`### 📝 Mô tả nghiệp vụ`);
    parts.push(endpoint.description.trim());
    parts.push('');
  }

  // 3. Permissions & Auth
  parts.push(`### 🔒 Phân quyền & Xác thực`);
  const isPublic = endpoint.permission && /unauthenticated|none/i.test(endpoint.permission);
  parts.push(`- **Trạng thái:** ${isPublic ? '🟢 Không cần đăng nhập (Public)' : '🔴 Bắt buộc xác thực Bearer Token (Authenticated)'}`);
  if (endpoint.permission) {
    parts.push(`- **Chi tiết quyền (Apiato Permission):** \`${endpoint.permission}\``);
  }
  parts.push('');

  // 4. Request Headers Table
  if (headers && headers.length > 0) {
    parts.push(`### 📋 Request Headers`);
    parts.push(`| Header | Giá trị | Bắt buộc | Mô tả |`);
    parts.push(`| :--- | :--- | :---: | :--- |`);
    for (const h of headers) {
      const isReq = h.key.toLowerCase() === 'accept' || h.key.toLowerCase() === 'authorization' ? '**Có**' : 'Không';
      parts.push(`| \`${h.key}\` | \`${h.value || '-'}\` | ${isReq} | ${h.description || '-'} |`);
    }
    parts.push('');
  }

  // 5. Path Parameters Table
  if (pathVariables && pathVariables.length > 0) {
    parts.push(`### 🎯 Path Parameters (Tham số URL)`);
    parts.push(`| Tham số | Kiểu | Bắt buộc | Mô tả |`);
    parts.push(`| :--- | :---: | :---: | :--- |`);
    for (const pv of pathVariables) {
      parts.push(`| \`:${pv.key}\` | \`ID / Number\` | **Có** | ${pv.description || '-'} |`);
    }
    parts.push('');
  }

  // 6. Query Parameters Table
  if (queryParams && queryParams.length > 0) {
    parts.push(`### 🔍 Query Parameters (Tham số truy vấn & Apiato Criteria)`);
    parts.push(`| Tham số | Bắt buộc | Giá trị mẫu | Mô tả tính năng |`);
    parts.push(`| :--- | :---: | :--- | :--- |`);
    for (const qp of queryParams) {
      const isReq = qp.disabled ? 'Tùy chọn' : '**Bắt buộc**';
      parts.push(`| \`${qp.key}\` | ${isReq} | \`${qp.value || '-'}\` | ${qp.description || '-'} |`);
    }
    parts.push('');
  }

  // 7. Request Body Table & JSON Sample
  if (Array.isArray(endpoint.body) && endpoint.body.length > 0) {
    parts.push(`### 📦 Request Body`);
    parts.push(`| Trường dữ liệu | Kiểu | Bắt buộc | Giá trị mẫu | Mô tả |`);
    parts.push(`| :--- | :---: | :---: | :--- | :--- |`);
    for (const b of endpoint.body) {
      const isReq = b.optional ? 'Không' : '**Có**';
      const sampleVal = String(bodyObj[b.field] !== undefined ? (typeof bodyObj[b.field] === 'object' ? JSON.stringify(bodyObj[b.field]) : bodyObj[b.field]) : '-');
      parts.push(`| \`${b.field}\` | \`${b.type || 'String'}\` | ${isReq} | \`${sampleVal}\` | ${b.description || '-'} |`);
    }
    parts.push('');

    parts.push(`#### 💡 Ví dụ Request Body (JSON)`);
    parts.push('```json');
    parts.push(JSON.stringify(bodyObj, null, 2));
    parts.push('```\n');
  }

  // 8. Fractal Includes Guide (if supported)
  if (availableIncludes && availableIncludes.length > 0) {
    parts.push(`### 🧬 Quan hệ lồng ghép (Fractal Eager Loading)`);
    parts.push(`Endpoint này hỗ trợ tải kèm dữ liệu quan hệ qua tham số \`?include=\`. Các tham số này đã được tạo sẵn theo từng dòng riêng biệt trong tab **Params** của Postman (để ở trạng thái tắt, bạn chỉ cần click chọn checkbox tương ứng để dùng):`);
    parts.push(`- **Tất cả các quan hệ khả dụng (${availableIncludes.length}):** ${availableIncludes.map(r => `\`${r}\``).join(', ')}`);
    if (availableIncludes.length > 1) {
      parts.push(`- **Nạp toàn bộ quan hệ đồng thời:** \`?include=${availableIncludes.join(',')}\``);
    }
    parts.push(`- **Nạp từng quan hệ riêng lẻ:** ${availableIncludes.map(r => `\`?include=${r}\``).join(', ')}\n`);
  }

  // 9. Response Examples Section
  parts.push(`### 🎯 Ví dụ Phản hồi (Response Examples)\n`);

  if (allLiveResponses && allLiveResponses.length > 0) {
    for (const liveResp of allLiveResponses) {
      parts.push(`#### ✅ ${liveResp.name || 'Phản hồi thực tế từ Server Live'} (${liveResp.code} ${liveResp.status})`);
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
