import fs from 'node:fs';
import vm from 'node:vm';
import { cleanHtml, safeJsonParse } from './utils.js';

export function parseApiDocHtml(htmlFilePath) {
  if (!fs.existsSync(htmlFilePath)) {
    throw new Error(`HTML documentation file not found: ${htmlFilePath}`);
  }

  const content = fs.readFileSync(htmlFilePath, 'utf8');

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

function normalizeEndpoint(item) {
  const method = (item.type || 'GET').toUpperCase();
  const rawUrl = item.url || '';
  const group = item.group || 'General';
  const groupTitle = item.groupTitle || group;
  const name = item.name || item.title || `${method}_${rawUrl}`;
  const title = item.title || name;
  const description = cleanHtml(item.description || '');

  // Extract Permission
  let permission = 'Authenticated';
  if (Array.isArray(item.permission) && item.permission.length > 0) {
    permission = item.permission.map(p => p.name).join(', ');
  }

  // Extract Headers
  const headers = [];
  const headerFields = item.header?.fields?.Header || [];
  for (const h of headerFields) {
    headers.push({
      key: h.field,
      value: h.defaultValue || (h.field.toLowerCase() === 'accept' ? 'application/json' : ''),
      description: cleanHtml(h.description || ''),
      optional: !!h.optional,
    });
  }

  // Extract Query and Path Parameters
  const params = [];
  const paramFields = item.parameter?.fields?.Parameter || [];
  for (const p of paramFields) {
    params.push({
      field: p.field,
      type: p.type || 'String',
      optional: !!p.optional,
      defaultValue: p.defaultValue || '',
      description: cleanHtml(p.description || ''),
      allowedValues: p.allowedValues || [],
    });
  }

  // Extract Request Body Fields
  const bodyFields = item.body || [];
  const body = [];
  for (const b of bodyFields) {
    body.push({
      field: b.field,
      type: b.type || 'String',
      optional: !!b.optional,
      defaultValue: b.defaultValue || '',
      description: cleanHtml(b.description || ''),
      allowedValues: b.allowedValues || [],
    });
  }

  // Extract Example Response
  let exampleResponse = null;
  const examples = item.success?.examples || [];
  if (examples.length > 0) {
    const rawContent = examples[0].content || '';
    // Format is usually HTTP/1.1 200 OK\n{...}
    const jsonStart = rawContent.indexOf('{');
    const arrayStart = rawContent.indexOf('[');
    let startIdx = -1;
    if (jsonStart !== -1 && arrayStart !== -1) {
      startIdx = Math.min(jsonStart, arrayStart);
    } else if (jsonStart !== -1) {
      startIdx = jsonStart;
    } else if (arrayStart !== -1) {
      startIdx = arrayStart;
    }

    if (startIdx !== -1) {
      const jsonText = rawContent.substring(startIdx).trim();
      exampleResponse = safeJsonParse(jsonText, jsonText);
    } else {
      exampleResponse = rawContent.trim();
    }
  }

  return {
    name,
    title,
    group,
    groupTitle,
    method,
    url: rawUrl,
    description,
    permission,
    headers,
    params,
    body,
    exampleResponse,
    raw: item,
  };
}
