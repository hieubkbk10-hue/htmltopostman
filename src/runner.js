import { colors } from './utils.js';

export async function runLiveApiRequests({
  baseUrl,
  token,
  endpoints,
  patchLimit = 20,
  timeout = 10000,
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const responsesMap = new Map(); // endpoint.name -> array of response objects
  const idPool = new Map();       // resource -> array of IDs
  const allIds = new Set();       // fallback pool of IDs

  // 1. Classify Endpoints
  const listGetEndpoints = [];
  const detailGetEndpoints = [];
  const patchEndpoints = [];

  for (const ep of endpoints) {
    if (ep.method === 'GET') {
      if (hasPathParam(ep.url)) {
        detailGetEndpoints.push(ep);
      } else {
        listGetEndpoints.push(ep);
      }
    } else if (ep.method === 'PATCH') {
      patchEndpoints.push(ep);
    }
  }

  console.log(colors.bold(`\n🚀 Live API Execution Plan:`));
  console.log(`  • List GET endpoints:   ${colors.green(listGetEndpoints.length)}`);
  console.log(`  • Detail GET endpoints: ${colors.cyan(detailGetEndpoints.length)}`);
  console.log(`  • PATCH endpoints:      ${colors.yellow(Math.min(patchLimit, patchEndpoints.length))} (limit: ${patchLimit})`);
  console.log(`  • Other endpoints:      ${endpoints.length - listGetEndpoints.length - detailGetEndpoints.length - patchEndpoints.length} (preserved without execution)\n`);

  // --- Phase 1: Run List GETs & Crawl IDs ---
  console.log(colors.bold(colors.blue(`--- Phase 1: Calling List GET Endpoints & Crawling IDs ---`)));
  for (const ep of listGetEndpoints) {
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
      }
    }
  }

  console.log(colors.green(`\n🎯 Crawled IDs summary: ${allIds.size} unique IDs across ${idPool.size} resource types.`));
  for (const [res, ids] of idPool.entries()) {
    console.log(`   - ${res}: ${ids.length} IDs (e.g. ${ids.slice(0, 3).join(', ')})`);
  }

  // --- Phase 2: Run Detail GETs using Crawled IDs ---
  console.log(colors.bold(colors.blue(`\n--- Phase 2: Calling Detail GET Endpoints with Crawled IDs ---`)));
  for (const ep of detailGetEndpoints) {
    const resourceName = extractResourceName(ep.url, ep.group);
    const idToUse = findBestId(resourceName, idPool, allIds);
    const resolvedUrl = substitutePathParams(ep.url, idToUse);

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
      }
    }
  }

  // --- Phase 3: Run PATCH Endpoints (up to patchLimit) ---
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

  console.log(colors.green(`\n✨ Live API execution completed. Captured real responses for ${responsesMap.size} endpoints.\n`));
  return responsesMap;
}

// Helpers

function hasPathParam(url) {
  return /:[a-zA-Z0-9_]+|{[a-zA-Z0-9_]+}/.test(url);
}

function extractResourceName(url, group) {
  const parts = url.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{') && p !== 'v1' && p !== 'api');
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
      console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('401')} ${url} ${colors.gray('(Unauthorized - skipped live response)')}`);
      return null;
    }

    const statusColor = res.ok ? colors.green : (res.status < 500 ? colors.yellow : colors.red);
    console.log(`  ${colors.bold(method.padEnd(6))} ${statusColor(res.status)} ${url} ${colors.gray(`(${res.statusText || 'OK'})`)}`);

    const postmanResponse = {
      name: `${method} ${url} - Live Response`,
      originalRequest: {
        method,
        header: Object.entries(headers).map(([k, v]) => ({ key: k, value: v })),
        url: {
          raw: `{{base_url}}${url}`,
          host: ['{{base_url}}'],
          path: url.split('/').filter(Boolean),
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
    console.log(`  ${colors.bold(method.padEnd(6))} ${colors.red('ERR')} ${url} ${colors.gray(`(${msg})`)}`);
    return null;
  }
}
