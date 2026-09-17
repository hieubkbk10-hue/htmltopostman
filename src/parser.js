import fs from 'node:fs';
import vm from 'node:vm';
import { cleanHtml, safeJsonParse } from './utils.js';

function readHtmlFile(htmlFilePath) {
  const bytes = fs.readFileSync(htmlFilePath);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function parseApiDocHtml(htmlFilePath) {
  if (!fs.existsSync(htmlFilePath)) {
    throw new Error(`HTML documentation file not found: ${htmlFilePath}`);
  }

  const content = readHtmlFile(htmlFilePath);

  // 1. Extract Project Info
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  const headerMatch = content.match(/<h1>([^<]+)<\/h1>\s*<h2>([^<]+)<\/h2>/i);

  const project = {
    title: headerMatch ? headerMatch[1].trim() : (titleMatch ? titleMatch[1].trim() : 'Apiato API Documentation'),
    description: headerMatch ? headerMatch[2].trim() : 'Apiato (Private API) Documentation',
  };

  // 2. Extract Raw Endpoints
  const rawEndpoints = extractRawEndpoints(content);
  if (!rawEndpoints || rawEndpoints.length === 0) {
    throw new Error('No ApiDoc endpoints found in the provided HTML file.');
  }

  // 3. Normalize Endpoints
  const normalized = rawEndpoints.map(item => normalizeEndpoint(item));

  return {
    project,
    endpoints: normalized,
  };
}

function extractRawEndpoints(htmlContent) {
  // Strategy 1: Find embedded array starting with [{group:
  const groupIdx = htmlContent.indexOf('[{group:');
  if (groupIdx !== -1) {
    const startIdx = groupIdx;
    for (let i = startIdx + 100; i < htmlContent.length; i++) {
      const char = htmlContent[i];
      const nextChar = htmlContent[i + 1] || '';
      if (char === ']' && (nextChar === ';' || nextChar === ',' || nextChar === '\n' || nextChar === '\r' || nextChar === '}' || nextChar === '<')) {
        try {
          const slice = htmlContent.substring(startIdx, i + 1);
          const parsed = vm.runInNewContext('(' + slice + ')');
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].group) {
            return parsed;
          }
        } catch {
          // continue searching
        }
      }
    }
  }

  // Strategy 2: Match var api_data or apiProject
  const apiDataMatch = htmlContent.match(/(?:var|let|const)?\s*api_data\s*=\s*(\[[^]*?\]);/);
  if (apiDataMatch) {
    try {
      const parsed = vm.runInNewContext('(' + apiDataMatch[1] + ')');
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }

  // Strategy 3: JSON script tag
  const scriptMatch = htmlContent.match(/<script[^>]*id=["']api_data["'][^>]*>([^<]+)<\/script>/i);
  if (scriptMatch) {
    const parsed = safeJsonParse(scriptMatch[1]);
    if (Array.isArray(parsed)) return parsed;
  }

  return [];
}

// ApiDoc stores permission either as [{name}] (old) or as plain PHP-ish strings
// like "Authenticated ['permissions' => 'manage-domains', 'roles' => ''] | isCustomer" (Apiato).
function normalizePermission(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map(p => (typeof p === 'string' ? p : (p && p.name) || ''));
  } else if (typeof raw === 'string' && raw.trim()) {
    list = [raw];
  }

  let isPublic = false;
  const names = [];

  for (const entry of list) {
    const s = String(entry).trim();
    if (!s) continue;
    if (/unauthenticated/i.test(s)) {
      isPublic = true;
      continue;
    }
    const permMatch = s.match(/'permissions'\s*=>\s*'([^']*)'/);
    if (permMatch) {
      for (const p of permMatch[1].split(',')) {
        const trimmed = p.trim();
        if (trimmed && !names.includes(trimmed)) names.push(trimmed);
      }
    } else if (/^none$/i.test(s)) {
      isPublic = true;
    } else if (!/^Authenticated\b/i.test(s) && !names.includes(s)) {
      names.push(s);
    }
  }

  const permission = names.length > 0
    ? names.join(', ')
    : (isPublic ? 'Unauthenticated' : 'Authenticated');

  return { permission, permissionNames: names, isPublic };
}

function extractFieldDocs(fieldsObj) {
  if (!fieldsObj || typeof fieldsObj !== 'object') return [];
  const out = [];
  for (const groupKey of Object.keys(fieldsObj)) {
    const arr = fieldsObj[groupKey];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      out.push({
        group: groupKey,
        field: f.field,
        type: f.type || 'String',
        optional: !!f.optional,
        defaultValue: f.defaultValue ?? '',
        description: cleanHtml(f.description || ''),
        allowedValues: f.allowedValues || [],
        size: f.size || '',
      });
    }
  }
  return out;
}

function extractStatusExamples(examplesArr) {
  if (!Array.isArray(examplesArr)) return [];
  const out = [];
  for (const ex of examplesArr) {
    const rawContent = typeof ex === 'string' ? ex : (ex.content || '');
    if (!rawContent) continue;
    const statusMatch = rawContent.match(/HTTP\/[\d.]+\s+(\d+)\s*([^\r\n]*)/i);
    const code = statusMatch ? parseInt(statusMatch[1], 10) : null;
    const status = statusMatch ? (statusMatch[2].trim() || null) : null;
    const jsonStart = Math.min(
      ...[rawContent.indexOf('{'), rawContent.indexOf('[')].filter(i => i !== -1),
    );
    let body;
    if (Number.isFinite(jsonStart) && jsonStart >= 0) {
      const jsonText = rawContent.substring(jsonStart).trim();
      body = safeJsonParse(jsonText, jsonText);
    } else {
      body = rawContent.trim();
    }
    out.push({ code, status, title: (ex && ex.title) || '', body });
  }
  return out;
}

function extractExampleResponse(item) {
  const examples = item.success?.examples || [];
  for (const ex of examples) {
    const parsed = extractStatusExamples([ex])[0];
    if (parsed && parsed.body !== undefined) return parsed.body;
  }
  return null;
}

function normalizeEndpoint(item) {
  let method = (item.type || 'GET').toUpperCase();
  if (method.includes('/')) {
    method = (Array.isArray(item.body) && item.body.length > 0) ? 'POST' : 'GET';
  }
  const rawUrl = item.url || '';
  const group = item.group || 'General';
  const groupTitle = item.groupTitle || group;
  const name = item.name || item.title || `${method}_${rawUrl}`;
  const title = item.title || name;
  const description = cleanHtml(item.description || '');

  const { permission, permissionNames, isPublic } = normalizePermission(item.permission);

  // Headers
  const headers = extractFieldDocs(item.header?.fields);

  // Path / body params from Parameter group
  const paramFields = extractFieldDocs(item.parameter?.fields);
  const params = paramFields.filter(f => f.group === 'Parameter' || !f.group);

  // Query Parameters
  const query = [];
  const rawQueryList = [];
  if (Array.isArray(item.query)) rawQueryList.push(...item.query);
  if (Array.isArray(item.parameter?.fields?.Query)) rawQueryList.push(...item.parameter.fields.Query);
  for (const q of rawQueryList) {
    if (!query.some(existing => existing.field === q.field)) {
      query.push({
        field: q.field,
        type: q.type || 'String',
        optional: !!q.optional,
        defaultValue: q.defaultValue || '',
        description: cleanHtml(q.description || ''),
        allowedValues: q.allowedValues || [],
      });
    }
  }

  // Request Body Fields (Apiato body entries are usually group: 'Body')
  const body = (item.body || []).map(b => ({
    field: b.field,
    type: b.type || 'String',
    optional: !!b.optional,
    defaultValue: b.defaultValue || '',
    description: cleanHtml(b.description || ''),
    allowedValues: b.allowedValues || [],
    size: b.size || '',
  }));

  // Response + error field docs (newly extracted — previously dropped)
  const responseFields = extractFieldDocs(item.success?.fields);
  const errorFields = extractFieldDocs(item.error?.fields);
  const errorExamples = extractStatusExamples(item.error?.examples);
  const successExamples = extractStatusExamples(item.success?.examples);

  const exampleResponse = extractExampleResponse(item);

  return {
    name,
    title,
    group,
    groupTitle,
    method,
    url: rawUrl,
    version: item.version || '',
    filename: item.filename || '',
    deprecated: !!(item.deprecated || item.sameDomain === false),
    description,
    permission,
    permissionNames,
    isPublic,
    headers,
    params,
    query,
    body,
    responseFields,
    errorFields,
    successExamples,
    errorExamples,
    exampleResponse,
    raw: item,
  };
}
