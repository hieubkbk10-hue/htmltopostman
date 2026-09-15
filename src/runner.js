import { colors } from './utils.js';

export async function runLiveApiRequests({
  baseUrl,
  token,
  endpoints,
  includePatch = false,
  patchLimit = 20,
  includePost = false,
  postLimit = 10,
  concurrency = 4,
  timeout = 10000,
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const responsesMap = new Map(); // endpoint.name -> array of response objects
  const idPool = new Map();       // resource -> array of IDs
  const allIds = new Set();       // fallback pool of IDs
  const entityPool = {
    domains: new Set(),
    emails: new Set(),
  };
  const runLog = [];

  // Derive root domain from baseUrl
  try {
    const parsedHost = new URL(normalizedBaseUrl).hostname.replace(/^(api\.|crm-api\.)/, '');
    if (parsedHost) entityPool.domains.add(parsedHost);
  } catch {}

  // 1. Classify Endpoints
  const listGetEndpoints = [];
  const detailGetEndpoints = [];
  const patchEndpoints = [];
  const postEndpoints = [];
  const otherEndpoints = [];

  for (const ep of endpoints) {
    if (ep.method === 'GET') {
      if (hasPathParam(ep.url)) detailGetEndpoints.push(ep);
      else listGetEndpoints.push(ep);
    } else if (ep.method === 'PATCH') {
      patchEndpoints.push(ep);
    } else if (ep.method === 'POST') {
      postEndpoints.push(ep);
    } else {
      otherEndpoints.push(ep);
    }
  }

  console.log(colors.bold(`\nLive API Execution Plan:`));
  console.log(`  • List GET endpoints:   ${colors.green(listGetEndpoints.length)} (Live & Dependency Crawling)`);
  console.log(`  • Detail GET endpoints: ${colors.cyan(detailGetEndpoints.length)} (Live with Crawled IDs)`);
  if (includePatch) {
    console.log(`  • PATCH endpoints:      ${colors.yellow(Math.min(patchLimit, patchEndpoints.length))} (limit: ${patchLimit})`);
  }
  if (includePost) {
    console.log(`  • POST endpoints:       ${colors.yellow(Math.min(postLimit, postEndpoints.length))} (limit: ${postLimit})`);
  }
  if (!includePatch && !includePost) {
    console.log(`  • Mutating endpoints:   ${colors.gray(patchEndpoints.length + postEndpoints.length + otherEndpoints.length)} (skipped live to protect data; add --include-patch/--include-post to run)`);
  }
  console.log(`  • Concurrency:          ${concurrency}\n`);

  // Split List GET endpoints into Base (independent) and Query-dependent
  const baseListGets = [];
  const queryDependentGets = [];
  for (const ep of listGetEndpoints) {
    const hasRequiredQuery = (ep.query || []).some(q => !q.optional);
    if (hasRequiredQuery) queryDependentGets.push(ep);
    else baseListGets.push(ep);
  }

  // --- Phase 1A: Base List GETs (concurrently in batches) ---
  console.log(colors.bold(colors.blue(`--- Phase 1A: Base List GETs & Crawling ---`)));
  await runPool(baseListGets, async (ep) => {
    const resInfo = await executeRequest({ baseUrl: normalizedBaseUrl, token, endpoint: ep, url: ep.url, method: 'GET', timeout, runLog });
    if (!resInfo) return;
    responsesMap.set(ep.name, [resInfo.postmanResponse]);
    if (resInfo.data) {
      ingestDiscovery(ep, resInfo.data, { idPool, allIds, entityPool, responsesMap, normalizedBaseUrl, token, timeout, runLog });
      await maybeTestIncludes(ep, ep.url, resInfo.data, { normalizedBaseUrl, token, responsesMap, allIds, entityPool, timeout, runLog });
    }
  }, concurrency);

  // --- Phase 1B: Query-Dependent List GETs (sequential enough — need crawled entities first) ---
  await runPool(queryDependentGets, async (ep) => {
    const queryParams = resolveQueryParams(ep, entityPool, idPool, allIds);
    let resolvedUrl = ep.url;
    if (queryParams.size > 0) {
      const qs = queryParams.toString();
      resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
    }
    const resInfo = await executeRequest({ baseUrl: normalizedBaseUrl, token, endpoint: ep, url: resolvedUrl, method: 'GET', timeout, runLog });
    if (!resInfo) return;
    responsesMap.set(ep.name, [resInfo.postmanResponse]);
    if (resInfo.data) {
      ingestDiscovery(ep, resInfo.data, { idPool, allIds, entityPool, responsesMap, normalizedBaseUrl, token, timeout, runLog });
      await maybeTestIncludes({ ...ep, url: resolvedUrl }, resolvedUrl, resInfo.data, { normalizedBaseUrl, token, responsesMap, allIds, entityPool, timeout, runLog });
    }
  }, Math.min(concurrency, 2));

  console.log(colors.green(`\n  Crawled dependencies:`));
  console.log(`   - IDs: ${allIds.size} unique IDs across ${idPool.size} resource types`);
  for (const [res, ids] of idPool.entries()) {
    console.log(`     • ${res}: ${ids.length} IDs (e.g. ${ids.slice(0, 3).join(', ')})`);
  }
  if (entityPool.domains.size > 0) console.log(`   - Domains: ${Array.from(entityPool.domains).slice(0, 3).join(', ')}`);

  // --- Phase 2: Detail GETs with Crawled IDs ---
  console.log(colors.bold(colors.blue(`\n--- Phase 2: Detail GETs with Crawled IDs ---`)));
  await runPool(detailGetEndpoints, async (ep) => {
    const resourceName = extractResourceName(ep.url, ep.group);
    const idToUse = findBestId(resourceName, idPool, allIds);
    let resolvedUrl = substitutePathParams(ep.url, idToUse);
    const queryParams = resolveQueryParams(ep, entityPool, idPool, allIds);
    if (queryParams.size > 0) {
      const qs = queryParams.toString();
      resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
    }
    const resInfo = await executeRequest({ baseUrl: normalizedBaseUrl, token, endpoint: ep, url: resolvedUrl, method: 'GET', timeout, runLog });
    if (!resInfo) return;
    responsesMap.set(ep.name, [resInfo.postmanResponse]);
    if (resInfo.data) {
      for (const id of extractIds(resInfo.data)) allIds.add(id);
      extractEntities(resInfo.data, entityPool);
      await maybeTestIncludes({ ...ep, url: resolvedUrl }, resolvedUrl, resInfo.data, { normalizedBaseUrl, token, responsesMap, allIds, entityPool, timeout, runLog });
    }
  }, concurrency);

  // --- Phase 3: Optional PATCH ---
  if (includePatch && patchEndpoints.length > 0) {
    console.log(colors.bold(colors.blue(`\n--- Phase 3: PATCH (up to ${patchLimit}) ---`)));
    let executed = 0;
    for (const ep of patchEndpoints) {
      if (executed >= patchLimit) {
        console.log(colors.gray(`  [Limit reached] Skipping remaining PATCH (${executed}/${patchLimit}).`));
        break;
      }
      const resourceName = extractResourceName(ep.url, ep.group);
      const idToUse = findBestId(resourceName, idPool, allIds);
      const resolvedUrl = substitutePathParams(ep.url, idToUse);
      const bodyPayload = buildPayload(ep);
      const resInfo = await executeRequest({ baseUrl: normalizedBaseUrl, token, endpoint: ep, url: resolvedUrl, method: 'PATCH', body: bodyPayload, timeout, runLog });
      executed++;
      if (resInfo) responsesMap.set(ep.name, [resInfo.postmanResponse]);
    }
  }

  // --- Phase 4: Optional POST (safe-ish: sample payload from docs) ---
  if (includePost && postEndpoints.length > 0) {
    console.log(colors.bold(colors.blue(`\n--- Phase 4: POST (up to ${postLimit}) ---`)));
    let executed = 0;
    for (const ep of postEndpoints) {
      if (executed >= postLimit) {
        console.log(colors.gray(`  [Limit reached] Skipping remaining POST (${executed}/${postLimit}).`));
        break;
      }
      let resolvedUrl = ep.url;
      const pathId = findBestId(extractResourceName(ep.url, ep.group), idPool, allIds);
      resolvedUrl = substitutePathParams(resolvedUrl, pathId);
      const queryParams = resolveQueryParams(ep, entityPool, idPool, allIds);
      if (queryParams.size > 0) {
        const qs = queryParams.toString();
        resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
      }
      const bodyPayload = buildPayload(ep);
      const resInfo = await executeRequest({ baseUrl: normalizedBaseUrl, token, endpoint: ep, url: resolvedUrl, method: 'POST', body: bodyPayload, timeout, runLog });
      executed++;
      if (resInfo) {
        responsesMap.set(ep.name, [resInfo.postmanResponse]);
        if (resInfo.data) {
          for (const id of extractIds(resInfo.data)) allIds.add(id);
          extractEntities(resInfo.data, entityPool);
        }
      }
    }
  }

  console.log(colors.green(`\n  Live execution completed. Captured responses for ${responsesMap.size} endpoints (${runLog.filter(e => e.ok).length} successes).\n`));
  if (runLog.some(e => /x-ratelimit/i.test(String(e.rateLimit || '')))) {
    console.log(colors.yellow('  (RateLimit headers observed — consider lowering --concurrency if you hit 429.)\n'));
  }
  return { responsesMap, runLog };
}

function ingestDiscovery(ep, data, { idPool, allIds, entityPool }) {
  const resourceName = extractResourceName(ep.url, ep.group);
  const crawledIds = extractIds(data);
  if (crawledIds.length > 0) {
    if (!idPool.has(resourceName)) idPool.set(resourceName, []);
    for (const id of crawledIds) {
      const bucket = idPool.get(resourceName);
      if (!bucket.includes(id)) bucket.push(id);
      allIds.add(id);
    }
  }
  extractEntities(data, entityPool);
}

async function maybeTestIncludes(ep, url, data, ctx) {
  const includes = data?.meta?.include;
  if (!Array.isArray(includes) || includes.length === 0) return;
  await testAndCaptureIncludes({ baseUrl: ctx.normalizedBaseUrl, token: ctx.token, endpoint: { ...ep, url }, includes, responsesMap: ctx.responsesMap, allIds: ctx.allIds, entityPool: ctx.entityPool, timeout: ctx.timeout, runLog: ctx.runLog });
}

async function runPool(items, worker, concurrency) {
  if (!items.length) return;
  const n = Math.max(1, concurrency);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  const pool = Array.from({ length: Math.min(n, items.length) }, () => next());
  await Promise.all(pool);
}

// Helpers

function hasPathParam(url) {
  return /:[a-zA-Z0-9_]+|{[a-zA-Z0-9_]+}/.test(url);
}

function extractResourceName(url, group) {
  const cleanUrl = url.split('?')[0];
  const parts = cleanUrl.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{') && p !== 'v1' && p !== 'api');
  if (parts.length > 0) return parts[0].toLowerCase();
  return (group || 'general').toLowerCase();
}

function findBestId(resourceName, idPool, allIds) {
  const pool = idPool.get(resourceName);
  if (pool && pool.length > 0) return pool[0];
  for (const [key, ids] of idPool.entries()) {
    if (ids.length > 0 && (resourceName.startsWith(key) || key.startsWith(resourceName))) return ids[0];
  }
  if (allIds.size > 0) return Array.from(allIds)[0];
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
    if (Array.isArray(obj)) { for (const item of obj) walk(item, depth + 1); return; }
    if (typeof obj === 'object') {
      if ('id' in obj && obj.id !== null && obj.id !== undefined) ids.push(String(obj.id));
      if ('hashed_id' in obj && obj.hashed_id) ids.push(String(obj.hashed_id));
      for (const val of Object.values(obj)) if (typeof val === 'object' && val !== null) walk(val, depth + 1);
    }
  }
  walk(data);
  return [...new Set(ids)];
}

function extractEntities(data, entityPool) {
  function walk(obj, depth = 0) {
    if (!obj || depth > 5) return;
    if (Array.isArray(obj)) { for (const item of obj) walk(item, depth + 1); return; }
    if (typeof obj === 'object') {
      if (obj.domain_name && obj.domain_ext) entityPool.domains.add(`${obj.domain_name}${obj.domain_ext}`);
      else if (obj.domain && typeof obj.domain === 'string') entityPool.domains.add(obj.domain);
      if (obj.email && typeof obj.email === 'string') entityPool.emails.add(obj.email);
      for (const val of Object.values(obj)) if (typeof val === 'object' && val !== null) walk(val, depth + 1);
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
      continue;
    }
    if (String(key).toLowerCase().includes('domain')) {
      const v = entityPool.domains.size > 0 ? Array.from(entityPool.domains)[0] : 'example.com';
      params.append(key, v);
      continue;
    }
    if (String(key).toLowerCase().includes('email')) {
      const v = entityPool.emails.size > 0 ? Array.from(entityPool.emails)[0] : 'admin@admin.com';
      params.append(key, v);
      continue;
    }
    if (String(key).toLowerCase().includes('id')) {
      params.append(key, findBestId(String(key).replace(/_id$/, ''), idPool, allIds));
      continue;
    }
    if (key === 'search') {
      params.append(key, q.allowedValues && q.allowedValues[0] ? String(q.allowedValues[0]).replace(/^"|"$/g, '') : 'test');
      continue;
    }
    if (key === 'searchFields') {
      params.append(key, q.allowedValues && q.allowedValues[0] ? String(q.allowedValues[0]).replace(/^"|"$/g, '') : 'name:like');
      continue;
    }
    if (key === 'searchJoin') { params.append(key, 'and'); continue; }
    if (q.allowedValues && q.allowedValues.length > 0) {
      if (!q.optional) params.append(key, q.allowedValues[0].replace(/^"|"$/g, ''));
      continue;
    }
    if (!q.optional) {
      if (q.type?.toLowerCase() === 'number' || q.type?.toLowerCase().includes('int')) params.append(key, '1');
      else params.append(key, 'default');
    }
  }
  return params;
}

function parseQueryString(qs) {
  const result = [];
  const params = new URLSearchParams(qs);
  for (const [key, value] of params.entries()) result.push({ key, value });
  return result;
}

function buildPayload(endpoint) {
  const payload = {};
  if (Array.isArray(endpoint.body)) {
    for (const field of endpoint.body) {
      if (field.defaultValue) payload[field.field] = field.defaultValue;
      else if (field.allowedValues && field.allowedValues.length > 0) payload[field.field] = field.allowedValues[0].replace(/^"|"$/g, '');
      else payload[field.field] = '';
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
  runLog = [],
}) {
  const fullUrl = `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  const headers = { 'Accept': 'application/json' };
  if (token && !(endpoint.permission && /unauthenticated|none/i.test(endpoint.permission)) && !endpoint.isPublic) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  let requestBody = null;
  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  const logEntry = { endpoint: endpoint.name || endpoint.title || url, method, url, fullUrl, attemptedAt: new Date().toISOString() };
  try {
    const res = await fetch(fullUrl, { method, headers, body: requestBody, signal: controller.signal });
    clearTimeout(timeoutId);
    const durationMs = Date.now() - t0;
    const contentType = res.headers.get('content-type') || '';
    let responseData = null;
    let rawBody = '';
    if (contentType.includes('application/json')) {
      try { responseData = await res.json(); rawBody = JSON.stringify(responseData, null, 2); }
      catch { rawBody = await res.text(); }
    } else {
      rawBody = await res.text();
      try { responseData = JSON.parse(rawBody); } catch { responseData = rawBody; }
    }
    const responseHeaders = [];
    res.headers.forEach((val, key) => responseHeaders.push({ key, value: val }));
    const rate = res.headers.get('x-ratelimit-remaining') || res.headers.get('ratelimit-remaining') || '';
    logEntry.status = res.status;
    logEntry.statusText = res.statusText || '';
    logEntry.durationMs = durationMs;
    logEntry.ok = res.ok;
    logEntry.cached = String(res.headers.get('x-cache') || '').toLowerCase().includes('hit');
    if (rate) logEntry.rateLimit = rate;
    if (!res.ok) logEntry.bodyPreview = rawBody.slice(0, 600);
    runLog.push(logEntry);

    if (res.status === 401 && !(endpoint.permission && /unauthenticated|none/i.test(endpoint.permission)) && !endpoint.isPublic) {
      if (!isIncludeTest) console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('401')} ${url} ${colors.gray('(Unauthorized — skipped)')}`);
      return null;
    }
    const statusColor = res.ok ? colors.green : (res.status < 500 ? colors.yellow : colors.red);
    if (!isIncludeTest) console.log(`  ${colors.bold(method.padEnd(6))} ${statusColor(res.status)} ${url} ${colors.gray(`(${res.statusText || 'OK'} · ${durationMs}ms)`)}`);

    const pathPart = url.split('?')[0];
    const queryPart = url.includes('?') ? url.split('?')[1] : null;
    const postmanResponse = {
      name: isIncludeTest ? `${method} ${url} - Live Response (Eager Loading)` : `${method} ${url} - Live Response`,
      originalRequest: {
        method,
        header: Object.entries(headers).map(([k, v]) => ({ key: k, value: v })),
        url: {
          raw: `{{base_url}}${url}`,
          host: ['{{base_url}}'],
          path: pathPart.split('/').filter(Boolean),
          query: queryPart ? parseQueryString(queryPart) : undefined,
        },
        body: requestBody ? { mode: 'raw', raw: requestBody, options: { raw: { language: 'json' } } } : undefined,
      },
      status: res.statusText || (res.ok ? 'OK' : 'Error'),
      code: res.status,
      _postman_previewlanguage: 'json',
      header: responseHeaders,
      cookie: [],
      body: rawBody,
    };
    return { status: res.status, data: responseData, postmanResponse };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === 'AbortError' ? 'Timeout' : err.message;
    logEntry.error = msg;
    logEntry.durationMs = Date.now() - t0;
    logEntry.ok = false;
    runLog.push(logEntry);
    if (!isIncludeTest) console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('ERR')} ${url} ${colors.gray(`(${msg})`)}`);
    return null;
  }
}

async function testAndCaptureIncludes({
  baseUrl, token, endpoint, includes, responsesMap, allIds, entityPool, timeout, runLog,
}) {
  if (!Array.isArray(includes) || includes.length === 0) return;
  const urlSeparator = endpoint.url.includes('?') ? '&' : '?';
  const fullIncludeParam = includes.join(',');
  const fullUrl = `${endpoint.url}${urlSeparator}include=${fullIncludeParam}`;
  console.log(`    ↳ ${colors.cyan('Eager Loading Test')}: ?include=${fullIncludeParam}`);
  const fullRes = await executeRequest({ baseUrl, token, endpoint, url: fullUrl, method: 'GET', timeout, isIncludeTest: true, runLog });
  if (fullRes && fullRes.status === 200 && fullRes.data) {
    console.log(`      ${colors.green('✓')} Eager loading ${includes.length} quan hệ thành công (200 OK)`);
    if (!responsesMap.has(endpoint.name)) responsesMap.set(endpoint.name, []);
    responsesMap.get(endpoint.name).push(fullRes.postmanResponse);
    for (const id of extractIds(fullRes.data)) allIds.add(id);
    extractEntities(fullRes.data, entityPool);
  } else {
    const errCode = fullRes ? fullRes.status : 'ERR';
    console.log(`      ${colors.yellow('⚠')} Gọi đồng thời ?include=${fullIncludeParam} thất bại (${errCode}). Kiểm tra từng quan hệ đơn lẻ...`);
    const workingIncludes = [];
    const brokenIncludes = [];
    for (const rel of includes) {
      const singleUrl = `${endpoint.url}${urlSeparator}include=${rel}`;
      const singleRes = await executeRequest({ baseUrl, token, endpoint, url: singleUrl, method: 'GET', timeout, isIncludeTest: true, runLog });
      if (singleRes && singleRes.status === 200 && singleRes.data) {
        workingIncludes.push(rel);
        for (const id of extractIds(singleRes.data)) allIds.add(id);
        extractEntities(singleRes.data, entityPool);
      } else {
        brokenIncludes.push({ rel, status: singleRes ? singleRes.status : 'ERR' });
      }
    }
    if (workingIncludes.length > 0) {
      console.log(`      ${colors.green('✓')} Quan hệ tốt: ${workingIncludes.join(', ')}`);
      const workingUrl = workingIncludes.length > 1
        ? `${endpoint.url}${urlSeparator}include=${workingIncludes.join(',')}`
        : `${endpoint.url}${urlSeparator}include=${workingIncludes[0]}`;
      const workingRes = await executeRequest({ baseUrl, token, endpoint, url: workingUrl, method: 'GET', timeout, isIncludeTest: true, runLog });
      if (workingRes && workingRes.status === 200) {
        if (!responsesMap.has(endpoint.name)) responsesMap.set(endpoint.name, []);
        responsesMap.get(endpoint.name).push(workingRes.postmanResponse);
      }
    }
    if (brokenIncludes.length > 0) {
      const details = brokenIncludes.map(b => `${b.rel} (${b.status})`).join(', ');
      console.log(`      ${colors.yellow('💡 Lưu ý:')} Quan hệ lỗi: ${details} (thường do null-relationship / Transformer thiếu null-check).`);
    }
  }
}
