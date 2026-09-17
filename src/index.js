import fs from 'node:fs';
import path from 'node:path';
import { colors, parseArgs, askQuestion, normalizeBaseUrl, defaultOutputDir } from './utils.js';
import { parseApiDocHtml } from './parser.js';
import { loginAdmin } from './auth.js';
import { runLiveApiRequests } from './runner.js';
import { buildPostmanCollection, buildPostmanEnvironment } from './postman.js';
import { diffEndpoints, buildChangelogJson, buildChangelogHtml } from './diff.js';

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  printBanner();

  // 1. Resolve HTML path
  let htmlPath = args.html;
  if (!htmlPath) {
    htmlPath = await askQuestion('Enter path to ApiDoc HTML file');
  }

  if (!htmlPath) {
    console.error(colors.red('Error: HTML file path is required.'));
    process.exit(1);
  }

  // Handle surrounding quotes if passed in Windows cmd/pwsh
  htmlPath = htmlPath.replace(/^['"]|['"]$/g, '');

  if (!fs.existsSync(htmlPath)) {
    console.error(colors.red(`Error: File not found at "${htmlPath}"`));
    process.exit(1);
  }

  // 2. Parse HTML file
  console.log(colors.cyan(`\nParsing ApiDoc HTML: ${htmlPath}...`));
  const parsed = parseApiDocHtml(htmlPath);
  let { project, endpoints } = parsed;
  const totalParsed = endpoints.length;
  console.log(colors.green(`Successfully parsed ${endpoints.length} endpoints from "${project.title}"`));

  // 2b. Filter (optional): --filter-group / --filter-method
  const activeFilters = [];
  if (args.filterGroup) {
    const needle = args.filterGroup.toLowerCase();
    endpoints = endpoints.filter(ep => ((ep.groupTitle || ep.group || '').toLowerCase().includes(needle)));
    activeFilters.push(`group~"${args.filterGroup}" => ${endpoints.length}`);
  }
  if (args.filterMethod) {
    const needle = args.filterMethod.trim().toUpperCase();
    endpoints = endpoints.filter(ep => (ep.method || '').toUpperCase() === needle);
    activeFilters.push(`method=${needle} => ${endpoints.length}`);
  }
  if (activeFilters.length > 0) {
    console.log(colors.cyan(`  Filters:`));
    for (const f of activeFilters) console.log(colors.cyan(`    - ${f}`));
    if (endpoints.length === 0) {
      console.warn(colors.yellow('Warning: filters removed all endpoints — nothing to generate.'));
    }
  }

  let changelog = null;
  if (args.old) {
    const oldPath = args.old.replace(/^['"]|['"]$/g, '');
    if (!fs.existsSync(oldPath)) {
      console.error(colors.red(`Error: File not found at "${oldPath}"`));
      process.exit(1);
    }
    console.log(colors.cyan(`Comparing previous ApiDoc HTML: ${oldPath}...`));
    const oldParsed = parseApiDocHtml(oldPath);
    let oldEndpoints = oldParsed.endpoints;
    if (args.filterGroup) {
      const needle = args.filterGroup.toLowerCase();
      oldEndpoints = oldEndpoints.filter(ep => ((ep.groupTitle || ep.group || '').toLowerCase().includes(needle)));
    }
    if (args.filterMethod) {
      const needle = args.filterMethod.trim().toUpperCase();
      oldEndpoints = oldEndpoints.filter(ep => (ep.method || '').toUpperCase() === needle);
    }
    const endpointDiff = diffEndpoints(oldEndpoints, endpoints);
    changelog = buildChangelogJson({
      oldFile: oldPath,
      newFile: htmlPath,
      oldProject: oldParsed.project,
      newProject: project,
      oldCount: oldEndpoints.length,
      newCount: endpoints.length,
      oldFramework: args.oldFramework,
      framework: args.framework,
      oldDate: getDocumentDate(oldPath),
      currentDate: getDocumentDate(htmlPath),
      diff: endpointDiff,
    });
    console.log(colors.yellow(`API changes: ${changelog.summary.breaking} breaking, ${changelog.summary.changed} changed, ${changelog.summary.added} added.`));
  }

  // 3. Resolve Base URL & Live Mode
  let baseUrl = args.baseUrl;
  const noLive = args.noLive;

  if (!noLive && !baseUrl) {
    const entered = await askQuestion('Enter backend Base URL for live response capture (leave blank to skip live)');
    baseUrl = entered.trim();
  }

  let token = args.token || '';
  let liveResponses = new Map();
  let runLog = [];
  let authMeta = { mode: token ? 'token' : 'none', loginTried: false, loginOk: false };

  if (!noLive && baseUrl) {
    baseUrl = normalizeBaseUrl(baseUrl);

    // 4. Authenticate or use provided token
    if (!token) {
      authMeta.mode = 'login';
      authMeta.loginTried = true;
      const authResult = await loginAdmin({
        baseUrl,
        email: args.email,
        password: args.password,
      });

      if (authResult.success) {
        token = authResult.token;
        authMeta.loginOk = true;
      } else {
        console.warn(colors.yellow(`\nAuthentication failed (HTTP ${authResult.status || 'ERR'}): ${authResult.error}`));
        console.log(colors.cyan('Choose how to proceed:'));
        console.log('   [0] Use default credentials (admin@admin.com / admin)');
        console.log('   [1] Paste Bearer token directly');
        console.log('   [2] Re-enter custom email & password to retry login');
        console.log('   [3] Switch to offline mode (use doc examples, avoid 401 errors)\n');

        const choice = await askQuestion('Select option (0/1/2/3)', '0');

        if (choice === '0') {
          console.log(colors.cyan('Retrying with default credentials (admin@admin.com / admin)...'));
          const retryAuth = await loginAdmin({
            baseUrl,
            email: 'admin@admin.com',
            password: 'admin',
          });
          if (retryAuth.success) {
            token = retryAuth.token;
            authMeta.loginOk = true;
          }
        } else if (choice === '1') {
          const inputToken = await askQuestion('Paste your Bearer token');
          if (inputToken) {
            token = inputToken.replace(/^Bearer\s+/i, '').trim();
            authMeta.mode = 'token';
            authMeta.loginOk = !!token;
            console.log(colors.green('Bearer token applied.'));
          }
        } else if (choice === '2') {
          const newEmail = await askQuestion('Enter email', 'admin@admin.com');
          const newPass = await askQuestion('Enter password', 'admin');
          if (newEmail && newPass) {
            const retryAuth = await loginAdmin({
              baseUrl,
              email: newEmail,
              password: newPass,
            });
            if (retryAuth.success) {
              token = retryAuth.token;
              authMeta.loginOk = true;
            }
          }
        } else if (choice === '3') {
          authMeta.mode = 'offline';
        }
      }
    } else {
      token = token.replace(/^Bearer\s+/i, '').trim();
      authMeta.mode = 'token';
      authMeta.loginOk = !!token;
      console.log(colors.green('Using Bearer token provided via command-line.'));
    }

    if (token) {
      // 5. Run Live API Calls with valid token
      const liveResult = await runLiveApiRequests({
        baseUrl,
        token,
        endpoints,
        includePatch: args.includePatch,
        patchLimit: args.patchLimit,
        includePost: args.includePost,
        postLimit: args.postLimit,
        concurrency: args.concurrency,
      });
      liveResponses = liveResult.responsesMap || liveResult;
      runLog = liveResult.runLog || [];
    } else {
      console.log(colors.yellow('\nNo valid token available. Generating Postman collection in offline mode to preserve documentation examples.'));
      authMeta.mode = 'offline';
    }
  } else {
    console.log(colors.yellow('Offline mode: skipping live API requests. Generating Postman collection with doc examples.'));
    authMeta.mode = 'offline';
  }

  // 6. Build Postman Collection
  console.log(colors.cyan('Generating Postman Collection v2.1.0...'));
  const collection = buildPostmanCollection({
    project,
    endpoints,
    baseUrl: baseUrl || '{{base_url}}',
    token,
    liveResponses,
  });

  // 7. Build companion artefacts
  const environment = buildPostmanEnvironment({ project, baseUrl: baseUrl || '{{base_url}}', token, email: args.email, password: args.password });
  const context = buildContextJson({
    project, endpoints, liveResponses, runLog, authMeta, baseUrl, args, totalParsed, changelog,
  });
  const openApiSpec = buildOpenApiSpec({ project, endpoints, baseUrl: baseUrl || 'https://api.example.com' });

  // 8. Save all outputs — by default into output/ (cleaned) or to a single path if --output given
  const timestamp = getFormattedTimestamp();
  const apiName = (project.title || 'apiato')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'apiato';
  const baseName = `${timestamp}_${apiName}`;

  const ensureDir = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });

  if (args.output) {
    const collectionPath = path.resolve(process.cwd(), args.output);
    ensureDir(collectionPath);
    const dir = path.dirname(collectionPath);
    const withoutExt = path.basename(collectionPath).replace(/\.postman_collection\.json$/i, '').replace(/\.json$/i, '') || baseName;
    const envPath = path.join(dir, `${withoutExt}.postman_environment.json`);
    const ctxPath = path.join(dir, `${withoutExt}.context.json`);
    const logPath = path.join(dir, `${withoutExt}.run-log.json`);
    const oasPath = path.join(dir, `${withoutExt}.openapi.json`);
    writeArtifacts({ collectionPath, envPath, ctxPath, logPath, oasPath, collection, environment, context, openApiSpec, runLog, args });
    const extra = writeHistoryAndChangelog({ dir, baseName: withoutExt, htmlPath, changelog });
    printSuccessReport({ collectionPath, envPath, ctxPath: args.noContext ? null : ctxPath, logPath: args.noContext ? null : logPath, oasPath, context, collection, liveResponses, changelog: extra });
  } else {
    cleanOutputDirectory(defaultOutputDir);
    fs.mkdirSync(defaultOutputDir, { recursive: true });
    const collectionPath = path.join(defaultOutputDir, `${baseName}.postman_collection.json`);
    const envPath = path.join(defaultOutputDir, `${baseName}.postman_environment.json`);
    const ctxPath = path.join(defaultOutputDir, `${baseName}.context.json`);
    const logPath = path.join(defaultOutputDir, `${baseName}.run-log.json`);
    const oasPath = path.join(defaultOutputDir, `${baseName}.openapi.json`);
    const readmePath = path.join(defaultOutputDir, 'README.txt');
    writeArtifacts({ collectionPath, envPath, ctxPath, logPath, oasPath, collection, environment, context, openApiSpec, runLog, args });
    fs.writeFileSync(readmePath, buildOutputReadme({ baseName, context }), 'utf8');
    const extra = writeHistoryAndChangelog({ dir: defaultOutputDir, baseName, htmlPath, changelog });
    printSuccessReport({ collectionPath, envPath, ctxPath: args.noContext ? null : ctxPath, logPath: args.noContext ? null : logPath, oasPath, context, collection, liveResponses, changelog: extra });
  }
}

function writeArtifacts({ collectionPath, envPath, ctxPath, logPath, oasPath, collection, environment, context, openApiSpec, runLog, args }) {
  fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2), 'utf8');
  fs.writeFileSync(envPath, JSON.stringify(environment, null, 2), 'utf8');
  if (!args.noContext) {
    fs.writeFileSync(ctxPath, JSON.stringify(context, null, 2), 'utf8');
    fs.writeFileSync(logPath, JSON.stringify({ generatedAt: context.generatedAt, baseUrl: context.baseUrl, runLog, diff: context.changelog }, null, 2), 'utf8');
  }
  fs.writeFileSync(oasPath, JSON.stringify(openApiSpec, null, 2), 'utf8');
}

function getDocumentDate(htmlPath) {
  try {
    const bytes = fs.readFileSync(htmlPath);
    const raw = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3).toString('utf8')
      : (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); } })();
    const m = raw.match(/generator[^}]*time\s*[:=]\s*["']([^"']+)["']/i) || raw.match(/["']time["']\s*:\s*["']([^"']+)["']/i) || raw.match(/<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i);
    if (m && m[1] && m[1].trim() && !/<%/.test(m[1])) return m[1].trim();
  } catch { /* fallback to mtime */ }
  try {
    return fs.statSync(htmlPath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function writeHistoryAndChangelog({ dir, baseName, htmlPath, changelog }) {
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const snapshotPath = path.join(historyDir, 'current.html');
  let changed = true;
  if (fs.existsSync(snapshotPath)) {
    try {
      const a = fs.readFileSync(snapshotPath);
      const b = fs.readFileSync(htmlPath);
      const strip = (buf) => (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
      changed = !strip(a).equals(strip(b));
    } catch { changed = true; }
  }
  if (changed) fs.copyFileSync(htmlPath, snapshotPath);
  try {
    for (const f of fs.readdirSync(historyDir)) {
      if (f !== 'current.html' && f.endsWith('.html')) fs.unlinkSync(path.join(historyDir, f));
    }
  } catch { /* ignore */ }
  if (!changelog) return { snapshotPath, changed };
  const jsonPath = path.join(dir, `${baseName}.changelog.json`);
  const htmlReportPath = path.join(dir, `${baseName}.changelog.html`);
  fs.writeFileSync(jsonPath, JSON.stringify(changelog, null, 2), 'utf8');
  fs.writeFileSync(htmlReportPath, buildChangelogHtml(changelog), 'utf8');
  return { snapshotPath, jsonPath, htmlReportPath, changed };
}

function buildContextJson({ project, endpoints, liveResponses, runLog, authMeta, baseUrl, args, totalParsed, changelog }) {
  const groups = {};
  for (const ep of endpoints) {
    const g = ep.groupTitle || ep.group || 'General';
    if (!groups[g]) groups[g] = { name: g, count: 0, methods: {} };
    groups[g].count++;
    const m = (ep.method || '').toUpperCase();
    groups[g].methods[m] = (groups[g].methods[m] || 0) + 1;
  }
  const methodStats = {};
  for (const ep of endpoints) {
    const m = (ep.method || '').toUpperCase();
    methodStats[m] = (methodStats[m] || 0) + 1;
  }
  const okCount = runLog.filter(e => e.ok).length;
  const failCount = runLog.filter(e => !e.ok).length;
  const failed = runLog.filter(e => !e.ok).slice(0, 30).map(e => ({ method: e.method, url: e.url, status: e.status || e.error, durationMs: e.durationMs }));
  // crawled summary from run if available
  return {
    generatedAt: new Date().toISOString(),
    cli: 'htmltpostman',
    project: { title: project.title, description: project.description },
    baseUrl: baseUrl || '{{base_url}}',
    auth: authMeta,
    changelog: changelog ? changelog.summary : null,
    filters: {
      filterGroup: args.filterGroup || null,
      filterMethod: args.filterMethod || null,
      includePatch: !!args.includePatch,
      includePost: !!args.includePost,
      concurrency: args.concurrency,
    },
    stats: {
      totalParsed,
      totalExported: endpoints.length,
      totalGroups: Object.keys(groups).length,
      methods: methodStats,
      groups: Object.values(groups),
      live: {
        enabled: !!baseUrl && !args.noLive,
        attempts: runLog.length,
        successes: okCount,
        failures: failCount,
        failuresPreview: failed,
      },
      savedLiveResponses: liveResponses.size || 0,
    },
    groupsDetail: Object.values(groups),
    endpoints: endpoints.map(ep => ({
      name: ep.name,
      title: ep.title,
      method: ep.method,
      url: ep.url,
      group: ep.groupTitle || ep.group,
      version: ep.version || null,
      filename: ep.filename || null,
      permission: ep.permission,
      permissionNames: ep.permissionNames || [],
      isPublic: !!ep.isPublic,
      params: (ep.params || []).map(p => p.field),
      query: (ep.query || []).map(q => ({ field: q.field, optional: !!q.optional })),
      body: (ep.body || []).map(b => ({ field: b.field, type: b.type, optional: !!b.optional })),
      hasLiveResponse: liveResponses.has(ep.name),
    })),
    warnings: buildWarnings({ endpoints, runLog }),
    companionFiles: {
      collection: '*.postman_collection.json — import vao Postman (Collection).',
      environment: '*.postman_environment.json — import vao Postman (Environments), chua base_url/token/email/password.',
      context: '*.context.json — paste NGUYEN FILE nay cho AI Agent de nam toan bo ngu canh API trong 1 lan.',
      runLog: '*.run-log.json — log structured tung request live (status/duration/error) de debug.',
      openapi: '*.openapi.json — OpenAPI 3.0 spec (AI thích hơn Postman, dùng cho codegen).',
      ...(changelog ? { changelog: '*.changelog.json / *.changelog.html — lịch sử thay đổi API.' } : {}),
      history: 'history/current.html — snapshot HTML hiện tại, chỉ cập nhật khi tài liệu thay đổi.',
    },
    tips: [
      'Import cả 2 file collection + environment vào Postman, chọn environment ở góc trên bên trái.',
      'Chạy POST /v1/clients/web/login trước — Test Script tự lưu token vào {{token}}.',
      'Để AI hiểu nhanh: paste NGUYÊN FILE *.context.json (không cắt) vào prompt.',
    ],
  };
}

function buildWarnings({ endpoints: _endpoints, runLog }) {
  const w = [];
  const failedIncludes = runLog.filter(e => !e.ok && e.url && e.url.includes('include='));
  if (failedIncludes.length > 0) w.push(`${failedIncludes.length} include-eager-loading request that bai — co the do quan he null / Transformer thieu null-check.`);
  const rateLimited = runLog.some(e => String(e.rateLimit || '').trim() && Number(e.rateLimit) < 5);
  if (rateLimited) w.push('Rate limit sap cham nguong (X-RateLimit-Remaining thap) — giam --concurrency.');
  return w;
}

function openApiTypeFor(fieldType) {
  const t = String(fieldType || '').toLowerCase();
  if (t.includes('number') || t.includes('int') || t.includes('float')) return { type: 'number' };
  if (t.includes('bool')) return { type: 'boolean' };
  if (t.includes('array') || t.includes('[]')) return { type: 'array', items: { type: 'string' } };
  if (t.includes('object')) return { type: 'object' };
  return { type: 'string' };
}

function buildOpenApiSpec({ project, endpoints, baseUrl }) {
  const paths = {};
  for (const ep of endpoints) {
    const method = String(ep.method || 'GET').toLowerCase();
    const oasPath = String(ep.url || '/').replace(/:([a-zA-Z0-9_]+)/g, '{$1}').replace(/\{([a-zA-Z0-9_]+)\}/g, '{$1}');
    if (!paths[oasPath]) paths[oasPath] = {};
    const params = [];
    for (const p of (ep.params || [])) {
      if (oasPath.includes(`{${p.field}}`)) {
        params.push({ name: p.field, in: 'path', required: !p.optional, schema: { type: 'string' }, description: p.description || '' });
      }
    }
    for (const q of (ep.query || [])) {
      params.push({ name: q.field, in: 'query', required: !q.optional, schema: openApiTypeFor(q.type), description: q.description || '' });
    }
    const operationId = String(ep.name || `${method}_${oasPath}`).replace(/[^a-zA-Z0-9_]/g, '_');
    const op = {
      operationId,
      summary: ep.title || ep.name || `${method.toUpperCase()} ${ep.url}`,
      description: (ep.description || '').slice(0, 2000),
      tags: [ep.groupTitle || ep.group || 'General'],
      parameters: params.length ? params : undefined,
    };
    if (ep.version) op['x-version'] = ep.version;
    if (ep.filename) op['x-filename'] = ep.filename;
    if (ep.isPublic) op.security = [];
    if (Array.isArray(ep.body) && ep.body.length > 0) {
      const props = {};
      const required = [];
      for (const b of ep.body) {
        props[b.field] = { ...openApiTypeFor(b.type), description: b.description || '' };
        if (!b.optional) required.push(b.field);
      }
      op.requestBody = {
        required: required.length > 0,
        content: { 'application/json': { schema: { type: 'object', properties: props, required: required.length ? required : undefined } } },
      };
    }
    paths[oasPath][method] = op;
  }
  return {
    openapi: '3.0.3',
    info: { title: project?.title || 'API', description: project?.description || '', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    security: [{ bearerAuth: [] }],
  };
}

function buildOutputReadme({ baseName, context }) {
  const lines = [
    `htmltpostman output — ${context.project.title} — ${context.generatedAt}`,
    '',
    `Base: ${baseName}`,
    `  - ${baseName}.postman_collection.json     -> Import vao Postman (Collections)`,
    `  - ${baseName}.postman_environment.json    -> Import vao Postman (Environments)`,
    `  - ${baseName}.context.json                -> PASTE NGUYEN FILE nay cho AI Agent`,
    `  - ${baseName}.run-log.json                -> Log chi tiet tung request live`,
    `  - ${baseName}.openapi.json                -> OpenAPI 3.0 (cho AI / codegen)`,
    ...(context.changelog ? [`  - ${baseName}.changelog.json/html     -> Lịch sử thay đổi API`] : []),
    `  - history/current.html                     -> Snapshot HTML tài liệu hiện tại`,
    '',
    `Endpoints: ${context.stats.totalExported}/${context.stats.totalParsed} | Live OK: ${context.stats.live.successes}/${context.stats.live.attempts}`,
    `Groups: ${context.stats.totalGroups} | Methods: ${JSON.stringify(context.stats.methods)}`,
  ];
  if (context.warnings && context.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of context.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n') + '\n';
}

function cleanOutputDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // ignore
  }
}

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(now.getDate());
  const month = pad(now.getMonth() + 1);
  const year = now.getFullYear();
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${day}-${month}-${year}_${hours}-${minutes}-${seconds}`;
}

function printBanner() {
  console.log(colors.bold(colors.magenta(`
=====================================================
  htmltpostman - ApiDoc HTML to Postman Collection
  with Live Response Capture & Dependency ID Crawler
=====================================================`)));
}

function printSuccessReport({ collectionPath, envPath, ctxPath, logPath, oasPath, context, collection, liveResponses, changelog }) {
  console.log(colors.bold(colors.green(`\nSuccess! Outputs generated:`)));
  console.log(colors.bold(`  Collection : ${collectionPath}`));
  console.log(colors.bold(`  Environment: ${envPath}`));
  console.log(colors.bold(`  OpenAPI    : ${oasPath}`));
  if (ctxPath) console.log(colors.bold(`  Context    : ${ctxPath}  <- paste NGUYÊN FILE này cho AI`));
  if (logPath) console.log(colors.bold(`  Run log    : ${logPath}`));
  if (changelog?.jsonPath) console.log(colors.bold(`  Changelog  : ${changelog.jsonPath}`));
  if (changelog?.htmlReportPath) console.log(colors.bold(`               ${changelog.htmlReportPath}`));
  if (changelog?.snapshotPath) console.log(colors.bold(`  Snapshot   : ${changelog.snapshotPath}`));
  console.log(colors.gray(`   • Total Endpoints:   ${context.stats.totalExported} (${context.stats.totalParsed} parsed)`));
  console.log(colors.gray(`   • Total Folders:     ${collection.item.length}`));
  console.log(colors.gray(`   • Live Responses:    ${liveResponses.size} (${context.stats.live.successes} OK / ${context.stats.live.attempts} attempts)`));
  if (context.changelog) {
    console.log(colors.yellow(`   • API Changes:       ${context.changelog.breaking} breaking, ${context.changelog.changed} changed, ${context.changelog.added} added`));
    if (context.changelog.breaking > 0) console.log(colors.red(`     Breaking changes cần kiểm tra!`));
  }
  if (context.warnings.length > 0) {
    console.log(colors.yellow(`   • Warnings:          ${context.warnings.join(' | ')}`));
  }
  console.log('');
}

function printHelp() {
  printBanner();
  console.log(`
Usage:
  htmltpostman [options]

Options:
  --html <path>         Path to ApiDoc HTML documentation file (current version)
  --old <path>          Previous HTML file; generate API changelog JSON and HTML
  --old-framework <str> Framework used by old docs, e.g. Laravel 9.x
  --framework <str>     Framework used by current docs, e.g. Laravel 11.x
  --base-url <url>, -u  Target backend base URL (e.g. https://api.example.com)
  --token <token>, -t   Bearer token for authenticated API requests
  --email <email>       Admin login email (default: admin@admin.com)
  --password <pass>     Admin login password (default: admin)
  --output <path>, -o   Output JSON collection file path (companions go beside it; defaults to ./output/)
  --include-patch       Enable live PATCH execution (default: false, safe GET-only)
  --patch-limit <num>   Maximum PATCH requests if enabled (default: 20)
  --include-post        Enable live POST execution (default: false, capped by --post-limit)
  --post-limit <num>    Maximum POST requests if enabled (default: 10)
  --concurrency <num>   Concurrent live requests (default: 4)
  --filter-group <str>  Only include endpoints whose group contains this string (case-insensitive)
  --filter-method <m>   Only include endpoints with this HTTP method (GET/POST/PATCH/...)
  --no-live             Offline mode: skip live API requests and use doc examples
  --no-context          Do not emit *.context.json / *.run-log.json sidecars
  --help, -h            Show this help message

Outputs (each run produces up to 5 files sharing the same timestamp base name):
  *.postman_collection.json   Postman collection (import into Postman)
  *.postman_environment.json  Postman environment (base_url/token/email/password)
  *.context.json              Machine-readable context — paste WHOLE FILE to an AI agent
  *.run-log.json              Structured log of every live request (status/duration/error)
  *.openapi.json              OpenAPI 3.0 spec derived from the same source

Examples:
  # Interactive mode
  htmltpostman

  # Using Bearer token directly
  htmltpostman --html "./docs.html" --base-url "https://api.example.com" --token "eyJhbG..."

  # Fast offline mode (outputs go to ./output/)
  htmltpostman --html "./docs.html" --no-live

  # Only export one group as Postman + OpenAPI
  htmltpostman --html "./docs.html" --filter-group Authentication --no-live
`);
}

export {
  parseApiDocHtml,
  loginAdmin,
  runLiveApiRequests,
  buildPostmanCollection,
};
