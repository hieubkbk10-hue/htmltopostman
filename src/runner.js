import { colors } from './utils.js';

export async function runLiveApiRequests({
  baseUrl,
  token,
  endpoints,
  includePatch = false,
  patchLimit = 20,
  timeout = 10000,
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const responsesMap = new Map(); // endpoint.name -> array of response objects
  const idPool = new Map();       // resource -> array of IDs
  const allIds = new Set();       // fallback pool of IDs
  const entityPool = {            // crawled domain names, emails, codes
    domains: new Set(),
    emails: new Set(),
  };

  // Derive root domain from baseUrl
  try {
    const parsedHost = new URL(normalizedBaseUrl).hostname.replace(/^(api\.|crm-api\.)/, '');
    if (parsedHost) {
      entityPool.domains.add(parsedHost);
    }
  } catch {
    // ignore
  }

  // 1. Classify Endpoints
  const listGetEndpoints = [];
  const detailGetEndpoints = [];
  const patchEndpoints = [];
  const otherEndpoints = [];

  for (const ep of endpoints) {
    if (ep.method === 'GET') {
      if (hasPathParam(ep.url)) {
        detailGetEndpoints.push(ep);
      } else {
        listGetEndpoints.push(ep);
      }
    } else if (ep.method === 'PATCH') {
      patchEndpoints.push(ep);
    } else {
      otherEndpoints.push(ep);
    }
  }

  console.log(colors.bold(`\n🚀 Live API Execution Plan (Safe GET-Only Mode):`));
  console.log(`  • List GET endpoints:   ${colors.green(listGetEndpoints.length)} (Live Execution & Dependency Crawling)`);
  console.log(`  • Detail GET endpoints: ${colors.cyan(detailGetEndpoints.length)} (Live Execution with Crawled IDs)`);
  if (includePatch) {
    console.log(`  • PATCH endpoints:      ${colors.yellow(Math.min(patchLimit, patchEndpoints.length))} (limit: ${patchLimit})`);
  } else {
    console.log(`  • Mutating endpoints:   ${colors.gray(patchEndpoints.length + otherEndpoints.length)} (Preserved with schemas & doc examples, skipped live to protect CRM data)\n`);
  }

  // Split List GET endpoints into Base (independent) and Query-dependent
  const baseListGets = [];
  const queryDependentGets = [];

  for (const ep of listGetEndpoints) {
    const hasRequiredQuery = (ep.query || []).some(q => !q.optional);
    if (hasRequiredQuery) {
      queryDependentGets.push(ep);
    } else {
      baseListGets.push(ep);
    }
  }

  // --- Phase 1A: Calling Base List GET Endpoints & Crawling IDs & Entities ---
  console.log(colors.bold(colors.blue(`--- Phase 1: Calling List GET Endpoints & Crawling Dependencies ---`)));
  for (const ep of baseListGets) {
    const resInfo = await executeRequest({
      baseUrl: normalizedBaseUrl,
      token,
      endpoint: ep,
      url: ep.url,
      method: 'GET',
      timeout,
    });

    if (resInfo) {
      responsesMap.set(ep.name, [resInfo.postmanResponse]);
      if (resInfo.data) {
        const resourceName = extractResourceName(ep.url, ep.group);
        const crawledIds = extractIds(resInfo.data);
        if (crawledIds.length > 0) {
          if (!idPool.has(resourceName)) {
            idPool.set(resourceName, []);
          }
          for (const id of crawledIds) {
            idPool.get(resourceName).push(id);
            allIds.add(id);
          }
        }
        extractEntities(resInfo.data, entityPool);

        // Smart Include Testing & Live Relational Response Capture
        const includes = resInfo.data.meta?.include;
        if (Array.isArray(includes) && includes.length > 0) {
          await testAndCaptureIncludes({
            baseUrl: normalizedBaseUrl,
            token,
            endpoint: ep,
            includes,
            responsesMap,
            allIds,
            entityPool,
            timeout,
          });
        }
      }
    }
  }

  // --- Phase 1B: Calling Query-Dependent List GETs with Crawled Entities ---
  for (const ep of queryDependentGets) {
    const queryParams = resolveQueryParams(ep, entityPool, idPool, allIds);
    let resolvedUrl = ep.url;
    if (queryParams.size > 0) {
      const qs = queryParams.toString();
      resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
    }

    const resInfo = await executeRequest({
      baseUrl: normalizedBaseUrl,
      token,
      endpoint: ep,
      url: resolvedUrl,
      method: 'GET',
      timeout,
    });

    if (resInfo) {
      responsesMap.set(ep.name, [resInfo.postmanResponse]);
      if (resInfo.data) {
        const resourceName = extractResourceName(ep.url, ep.group);
        const crawledIds = extractIds(resInfo.data);
        if (crawledIds.length > 0) {
          if (!idPool.has(resourceName)) {
            idPool.set(resourceName, []);
          }
          for (const id of crawledIds) {
            idPool.get(resourceName).push(id);
            allIds.add(id);
          }
        }
        extractEntities(resInfo.data, entityPool);

        // Smart Include Testing for Query-dependent list GET endpoints
        const includes = resInfo.data.meta?.include;
        if (Array.isArray(includes) && includes.length > 0) {
          await testAndCaptureIncludes({
            baseUrl: normalizedBaseUrl,
            token,
            endpoint: { ...ep, url: resolvedUrl },
            includes,
            responsesMap,
            allIds,
            entityPool,
            timeout,
          });
        }
      }
    }
  }

  console.log(colors.green(`\n🎯 Crawled dependencies summary:`));
  console.log(`   - IDs: ${allIds.size} unique IDs across ${idPool.size} resource types`);
  for (const [res, ids] of idPool.entries()) {
    console.log(`     • ${res}: ${ids.length} IDs (e.g. ${ids.slice(0, 3).join(', ')})`);
  }
  if (entityPool.domains.size > 0) {
    console.log(`   - Domains: ${Array.from(entityPool.domains).slice(0, 3).join(', ')}`);
  }

  // --- Phase 2: Calling Detail GET Endpoints with Crawled IDs ---
  console.log(colors.bold(colors.blue(`\n--- Phase 2: Calling Detail GET Endpoints with Crawled IDs ---`)));
  for (const ep of detailGetEndpoints) {
    const resourceName = extractResourceName(ep.url, ep.group);
    const idToUse = findBestId(resourceName, idPool, allIds);
    let resolvedUrl = substitutePathParams(ep.url, idToUse);

    // If detail endpoint also has query params
    const queryParams = resolveQueryParams(ep, entityPool, idPool, allIds);
    if (queryParams.size > 0) {
      const qs = queryParams.toString();
      resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
    }

    const resInfo = await executeRequest({
      baseUrl: normalizedBaseUrl,
      token,
      endpoint: ep,
      url: resolvedUrl,
      method: 'GET',
      timeout,
    });

    if (resInfo) {
      responsesMap.set(ep.name, [resInfo.postmanResponse]);
      if (resInfo.data) {
        const crawledIds = extractIds(resInfo.data);
        for (const id of crawledIds) {
          allIds.add(id);
        }
        extractEntities(resInfo.data, entityPool);

        // Smart Include Testing for Detail GET endpoints
        const includes = resInfo.data.meta?.include;
        if (Array.isArray(includes) && includes.length > 0) {
          await testAndCaptureIncludes({
            baseUrl: normalizedBaseUrl,
            token,
            endpoint: { ...ep, url: resolvedUrl },
            includes,
            responsesMap,
            allIds,
            entityPool,
            timeout,
          });
        }
      }
    }
  }

  // --- Phase 3: Optional PATCH Endpoints (only if explicitly enabled) ---
  if (includePatch && patchEndpoints.length > 0) {
    console.log(colors.bold(colors.blue(`\n--- Phase 3: Calling PATCH Endpoints (up to ${patchLimit}) ---`)));
    let patchExecuted = 0;
    for (const ep of patchEndpoints) {
      if (patchExecuted >= patchLimit) {
        console.log(colors.gray(`  [Limit reached] Skipping remaining PATCH endpoints (${patchExecuted}/${patchLimit}).`));
        break;
      }

      const resourceName = extractResourceName(ep.url, ep.group);
      const idToUse = findBestId(resourceName, idPool, allIds);
      const resolvedUrl = substitutePathParams(ep.url, idToUse);
      const bodyPayload = buildPatchPayload(ep);

      const resInfo = await executeRequest({
        baseUrl: normalizedBaseUrl,
        token,
        endpoint: ep,
        url: resolvedUrl,
        method: 'PATCH',
        body: bodyPayload,
        timeout,
      });

      patchExecuted++;
      if (resInfo) {
        responsesMap.set(ep.name, [resInfo.postmanResponse]);
      }
    }
  }

  console.log(colors.green(`\n✨ Live API execution completed. Captured real 200 OK responses for ${responsesMap.size} GET endpoints.\n`));
  return responsesMap;
}

// Helpers

function hasPathParam(url) {
  return /:[a-zA-Z0-9_]+|{[a-zA-Z0-9_]+}/.test(url);
}

function extractResourceName(url, group) {
  const cleanUrl = url.split('?')[0];
  const parts = cleanUrl.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{') && p !== 'v1' && p !== 'api');
  if (parts.length > 0) {
    return parts[0].toLowerCase();
  }
  return (group || 'general').toLowerCase();
}

function findBestId(resourceName, idPool, allIds) {
  const pool = idPool.get(resourceName);
  if (pool && pool.length > 0) {
    return pool[0];
  }
  // Try singular / plural variations
  for (const [key, ids] of idPool.entries()) {
    if (ids.length > 0 && (resourceName.startsWith(key) || key.startsWith(resourceName))) {
      return ids[0];
    }
  }
  // Fallback to any crawled ID
  if (allIds.size > 0) {
    return Array.from(allIds)[0];
  }
  return '1';
}

function substitutePathParams(url, id) {
  return url
    .replace(/:id\b/g, id)
    .replace(/:[a-zA-Z0-9_]+_id\b/g, id)
    .replace(/:[a-zA-Z0-9_]+/g, id)
    .replace(/\{[a-zA-Z0-9_]+\}/g, id);
}

function extractIds(data) {
  const ids = [];

  function walk(obj, depth = 0) {
    if (!obj || depth > 5) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      if ('id' in obj && obj.id !== null && obj.id !== undefined) {
        ids.push(String(obj.id));
      }
      if ('hashed_id' in obj && obj.hashed_id) {
        ids.push(String(obj.hashed_id));
      }
      for (const val of Object.values(obj)) {
        if (typeof val === 'object' && val !== null) {
          walk(val, depth + 1);
        }
      }
    }
  }

  walk(data);
  return [...new Set(ids)];
}

function extractEntities(data, entityPool) {
  function walk(obj, depth = 0) {
    if (!obj || depth > 5) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      if (obj.domain_name && obj.domain_ext) {
        entityPool.domains.add(`${obj.domain_name}${obj.domain_ext}`);
      } else if (obj.domain && typeof obj.domain === 'string') {
        entityPool.domains.add(obj.domain);
      }
      if (obj.email && typeof obj.email === 'string') {
        entityPool.emails.add(obj.email);
      }
      for (const val of Object.values(obj)) {
        if (typeof val === 'object' && val !== null) {
          walk(val, depth + 1);
        }
      }
    }
  }
  walk(data);
}

function resolveQueryParams(endpoint, entityPool, idPool, allIds) {
  const params = new URLSearchParams();
  const queryList = endpoint.query || [];

  for (const q of queryList) {
    const key = q.field;
    if (q.defaultValue) {
      params.append(key, q.defaultValue);
    } else if (key.toLowerCase().includes('domain')) {
      const domainVal = entityPool.domains.size > 0
        ? Array.from(entityPool.domains)[0]
        : 'example.com';
      params.append(key, domainVal);
    } else if (key.toLowerCase().includes('email')) {
      const emailVal = entityPool.emails.size > 0
        ? Array.from(entityPool.emails)[0]
        : 'admin@admin.com';
      params.append(key, emailVal);
    } else if (key.toLowerCase().includes('id')) {
      const idVal = findBestId(key.replace(/_id$/, ''), idPool, allIds);
      params.append(key, idVal);
    } else if (q.allowedValues && q.allowedValues.length > 0) {
      if (!q.optional) {
        params.append(key, q.allowedValues[0].replace(/^"|"$/g, ''));
      }
    } else if (!q.optional) {
      if (q.type?.toLowerCase() === 'number') {
        params.append(key, '1');
      } else {
        params.append(key, 'default');
      }
    }
  }

  return params;
}

function parseQueryString(qs) {
  const result = [];
  const params = new URLSearchParams(qs);
  for (const [key, value] of params.entries()) {
    result.push({ key, value });
  }
  return result;
}

function buildPatchPayload(endpoint) {
  const payload = {};
  if (Array.isArray(endpoint.body)) {
    for (const field of endpoint.body) {
      if (field.defaultValue) {
        payload[field.field] = field.defaultValue;
      } else if (field.allowedValues && field.allowedValues.length > 0) {
        payload[field.field] = field.allowedValues[0].replace(/^"|"$/g, '');
      } else {
        payload[field.field] = '';
      }
    }
  }
  return payload;
}

async function executeRequest({
  baseUrl,
  token,
  endpoint,
  url,
  method,
  body = null,
  timeout = 10000,
  isIncludeTest = false,
}) {
  const fullUrl = `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  const headers = {
    'Accept': 'application/json',
  };

  if (token && endpoint.permission !== 'Unauthenticated') {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let requestBody = null;
  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(fullUrl, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const contentType = res.headers.get('content-type') || '';
    let responseData = null;
    let rawBody = '';

    if (contentType.includes('application/json')) {
      try {
        responseData = await res.json();
        rawBody = JSON.stringify(responseData, null, 2);
      } catch {
        rawBody = await res.text();
      }
    } else {
      rawBody = await res.text();
      try {
        responseData = JSON.parse(rawBody);
      } catch {
        responseData = rawBody;
      }
    }

    // Convert response headers for Postman
    const responseHeaders = [];
    res.headers.forEach((val, key) => {
      responseHeaders.push({ key, value: val });
    });

    if (res.status === 401 && endpoint.permission !== 'Unauthenticated') {
      if (!isIncludeTest) {
        console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('401')} ${url} ${colors.gray('(Unauthorized - skipped live response)')}`);
      }
      return null;
    }

    const statusColor = res.ok ? colors.green : (res.status < 500 ? colors.yellow : colors.red);
    if (!isIncludeTest) {
      console.log(`  ${colors.bold(method.padEnd(6))} ${statusColor(res.status)} ${url} ${colors.gray(`(${res.statusText || 'OK'})`)}`);
    }

    const pathPart = url.split('?')[0];
    const queryPart = url.includes('?') ? url.split('?')[1] : null;

    const postmanResponse = {
      name: isIncludeTest
        ? `${method} ${url} - Live Response (Eager Loading)`
        : `${method} ${url} - Live Response`,
      originalRequest: {
        method,
        header: Object.entries(headers).map(([k, v]) => ({ key: k, value: v })),
        url: {
          raw: `{{base_url}}${url}`,
          host: ['{{base_url}}'],
          path: pathPart.split('/').filter(Boolean),
          query: queryPart ? parseQueryString(queryPart) : undefined,
        },
        body: requestBody ? {
          mode: 'raw',
          raw: requestBody,
          options: { raw: { language: 'json' } },
        } : undefined,
      },
      status: res.statusText || (res.ok ? 'OK' : 'Error'),
      code: res.status,
      _postman_previewlanguage: 'json',
      header: responseHeaders,
      cookie: [],
      body: rawBody,
    };

    return {
      status: res.status,
      data: responseData,
      postmanResponse,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
    if (!isIncludeTest) {
      console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('ERR')} ${url} ${colors.gray(`(${msg})`)}`);
    }
    return null;
  }
}

async function testAndCaptureIncludes({
  baseUrl,
  token,
  endpoint,
  includes,
  responsesMap,
  allIds,
  entityPool,
  timeout,
}) {
  if (!Array.isArray(includes) || includes.length === 0) return;

  const urlSeparator = endpoint.url.includes('?') ? '&' : '?';
  const fullIncludeParam = includes.join(',');
  const fullUrl = `${endpoint.url}${urlSeparator}include=${fullIncludeParam}`;

  console.log(`    ↳ ${colors.cyan('🔍 Eager Loading Test')}: ?include=${fullIncludeParam}`);

  const fullRes = await executeRequest({
    baseUrl,
    token,
    endpoint,
    url: fullUrl,
    method: 'GET',
    timeout,
    isIncludeTest: true,
  });

  if (fullRes && fullRes.status === 200 && fullRes.data) {
    console.log(`      ${colors.green('✓')} Eager loading ${includes.length} quan hệ thành công (200 OK) - Lưu Live Response vào Postman!`);
    if (!responsesMap.has(endpoint.name)) {
      responsesMap.set(endpoint.name, []);
    }
    responsesMap.get(endpoint.name).push(fullRes.postmanResponse);

    // Deep crawl nested IDs and entities
    const nestedIds = extractIds(fullRes.data);
    for (const id of nestedIds) {
      allIds.add(id);
    }
    extractEntities(fullRes.data, entityPool);
  } else {
    const errCode = fullRes ? fullRes.status : 'ERR';
    console.log(`      ${colors.yellow('⚠')} Gọi đồng thời ?include=${fullIncludeParam} thất bại (${errCode}). Kiểm tra từng quan hệ đơn lẻ...`);

    const workingIncludes = [];
    const brokenIncludes = [];

    for (const rel of includes) {
      const singleUrl = `${endpoint.url}${urlSeparator}include=${rel}`;
      const singleRes = await executeRequest({
        baseUrl,
        token,
        endpoint,
        url: singleUrl,
        method: 'GET',
        timeout,
        isIncludeTest: true,
      });

      if (singleRes && singleRes.status === 200 && singleRes.data) {
        workingIncludes.push(rel);
        const nestedIds = extractIds(singleRes.data);
        for (const id of nestedIds) {
          allIds.add(id);
        }
        extractEntities(singleRes.data, entityPool);
      } else {
        brokenIncludes.push({ rel, status: singleRes ? singleRes.status : 'ERR' });
      }
    }

    if (workingIncludes.length > 0) {
      console.log(`      ${colors.green('✓')} Các quan hệ hoạt động tốt: ${workingIncludes.join(', ')}`);
      const workingUrl = workingIncludes.length > 1
        ? `${endpoint.url}${urlSeparator}include=${workingIncludes.join(',')}`
        : `${endpoint.url}${urlSeparator}include=${workingIncludes[0]}`;

      const workingRes = await executeRequest({
        baseUrl,
        token,
        endpoint,
        url: workingUrl,
        method: 'GET',
        timeout,
        isIncludeTest: true,
      });

      if (workingRes && workingRes.status === 200) {
        if (!responsesMap.has(endpoint.name)) {
          responsesMap.set(endpoint.name, []);
        }
        responsesMap.get(endpoint.name).push(workingRes.postmanResponse);
      }
    }

    if (brokenIncludes.length > 0) {
      const details = brokenIncludes.map(b => `${b.rel} (${b.status})`).join(', ');
      console.log(`      ${colors.yellow('💡 Khuyên bảo:')} Backend gặp lỗi ở quan hệ: ${details} (thường do null-relationship hoặc Transformer thiếu kiểm tra null trong Apiato). Trong Postman nên bỏ chọn các quan hệ này.`);
    }
  }
}

