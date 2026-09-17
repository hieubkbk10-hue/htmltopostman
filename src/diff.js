function canonicalUrl(url) {
  const raw = String(url || '/').split('?')[0].trim() || '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const stripped = withSlash.replace(/\/+$/, '') || '/';
  return stripped;
}

function endpointKey(ep) {
  const method = String(ep.method || 'GET').toUpperCase();
  return `${method} ${canonicalUrl(ep.url)}`;
}

function mapByKey(endpoints) {
  const m = new Map();
  for (const ep of endpoints) m.set(endpointKey(ep), ep);
  return m;
}

function fieldMap(list) {
  const m = new Map();
  for (const f of list || []) m.set(f.field, f);
  return m;
}

function compareFieldLists(oldList, newList, kind) {
  const changes = [];
  const o = fieldMap(oldList);
  const n = fieldMap(newList);
  const label = { params: 'path', query: 'query', body: 'body' }[kind] || kind;
  for (const [field, of_] of o.entries()) {
    if (!n.has(field)) {
      const wasRequired = !of_.optional;
      changes.push({ field: `${kind}.${field}`, kind: wasRequired ? 'breaking' : 'changed', before: wasRequired ? 'bắt buộc' : 'tùy chọn', after: 'đã xóa', message: `Xóa ${label} \`${field}\` (${wasRequired ? 'trước đây bắt buộc — breaking' : 'tùy chọn'})` });
    } else {
      const nf = n.get(field);
      if (Boolean(of_.optional) !== Boolean(nf.optional)) {
        const toRequired = !nf.optional && of_.optional;
        changes.push({ field: `${kind}.${field}`, kind: toRequired ? 'breaking' : 'changed', before: of_.optional ? 'tùy chọn' : 'bắt buộc', after: nf.optional ? 'tùy chọn' : 'bắt buộc', message: `${label} \`${field}\` đổi từ ${of_.optional ? 'tùy chọn' : 'bắt buộc'} → ${nf.optional ? 'tùy chọn' : 'bắt buộc'}${toRequired ? ' — breaking' : ''}` });
      }
      if (String(of_.type || '') !== String(nf.type || '')) {
        changes.push({ field: `${kind}.${field}`, kind: 'changed', before: of_.type || '', after: nf.type || '', message: `${label} \`${field}\` đổi kiểu \`${of_.type}\` → \`${nf.type}\`` });
      }
    }
  }
  for (const [field] of n.entries()) {
    if (!o.has(field)) {
      const nf = n.get(field);
      const isRequired = !nf.optional;
      changes.push({ field: `${kind}.${field}`, kind: isRequired ? 'breaking' : 'changed', before: 'chưa có', after: isRequired ? 'bắt buộc' : 'tùy chọn', message: `Thêm ${label} \`${field}\` (${isRequired ? 'bắt buộc — breaking' : 'không bắt buộc'})` });
    }
  }
  return changes;
}

function diffEndpoint(oldEp, newEp) {
  const changes = [];
  if (String(oldEp.title || '') !== String(newEp.title || '')) changes.push({ field: 'title', kind: 'changed', before: oldEp.title || '', after: newEp.title || '', message: `Đổi tiêu đề: "${oldEp.title}" → "${newEp.title}"` });
  if (String(oldEp.description || '') !== String(newEp.description || '')) changes.push({ field: 'description', kind: 'changed', before: oldEp.description || '', after: newEp.description || '', message: `Mô tả endpoint thay đổi: “${oldEp.description || 'trống'}” → “${newEp.description || 'trống'}”` });
  if (String(oldEp.groupTitle || oldEp.group || '') !== String(newEp.groupTitle || newEp.group || '')) changes.push({ field: 'group', kind: 'changed', before: oldEp.groupTitle || oldEp.group || '', after: newEp.groupTitle || newEp.group || '', message: `Đổi nhóm: ${oldEp.groupTitle || oldEp.group} → ${newEp.groupTitle || newEp.group}` });
  if (String(oldEp.version || '') !== String(newEp.version || '')) changes.push({ field: 'version', kind: 'changed', before: oldEp.version || '', after: newEp.version || '', message: `Đổi phiên bản API: ${oldEp.version} → ${newEp.version}` });
  if (Boolean(oldEp.deprecated) !== Boolean(newEp.deprecated)) changes.push({ field: 'deprecated', kind: 'changed', before: oldEp.deprecated ? 'deprecated' : 'active', after: newEp.deprecated ? 'deprecated' : 'active', message: newEp.deprecated ? 'Endpoint bị đánh dấu deprecated' : 'Endpoint bỏ deprecated' });

  const oldPublic = !!oldEp.isPublic;
  const newPublic = !!newEp.isPublic;
  if (oldPublic !== newPublic) {
    const kind = oldPublic && !newPublic ? 'breaking' : 'changed';
    changes.push({ field: 'auth', kind, before: oldPublic ? 'public' : 'authenticated', after: newPublic ? 'public' : 'authenticated', message: oldPublic && !newPublic ? 'Endpoint trước đây không cần đăng nhập, nay bắt buộc Bearer Token — breaking' : 'Endpoint thay đổi yêu cầu đăng nhập' });
  }
  if (String(oldEp.permission || '') !== String(newEp.permission || '')) {
    changes.push({ field: 'permission', kind: 'changed', before: oldEp.permission || '', after: newEp.permission || '', message: `Đổi quyền: ${oldEp.permission || 'không ghi nhận'} → ${newEp.permission || 'không ghi nhận'}` });
  }

  changes.push(...compareFieldLists(oldEp.params, newEp.params, 'params'));
  changes.push(...compareFieldLists(oldEp.query, newEp.query, 'query'));
  changes.push(...compareFieldLists(oldEp.body, newEp.body, 'body'));

  // response fields changes are informational
  const oldRf = (oldEp.responseFields || []).map(f => f.field).sort().join(', ');
  const newRf = (newEp.responseFields || []).map(f => f.field).sort().join(', ');
  if (oldRf !== newRf) changes.push({ field: 'responseFields', kind: 'changed', before: oldRf, after: newRf, message: `Đổi cấu trúc response: ${oldRf || 'không có'} → ${newRf || 'không có'}` });

  return changes;
}

export function diffEndpoints(oldEndpoints, newEndpoints) {
  const oldMap = mapByKey(oldEndpoints || []);
  const newMap = mapByKey(newEndpoints || []);

  const added = [];
  const removed = [];
  const changed = [];
  const breaking = [];

  // method change detection: same canonical URL but different method
  const oldByUrl = new Map();
  for (const [k, ep] of oldMap.entries()) {
    const url = canonicalUrl(ep.url);
    if (!oldByUrl.has(url)) oldByUrl.set(url, []);
    oldByUrl.get(url).push({ key: k, ep });
  }
  const newByUrl = new Map();
  for (const [k, ep] of newMap.entries()) {
    const url = canonicalUrl(ep.url);
    if (!newByUrl.has(url)) newByUrl.set(url, []);
    newByUrl.get(url).push({ key: k, ep });
  }

  const handledOld = new Set();
  const handledNew = new Set();

  let unchanged = 0;
  for (const [key, oldEp] of oldMap.entries()) {
    if (newMap.has(key)) {
      const newEp = newMap.get(key);
      const changes = diffEndpoint(oldEp, newEp);
      handledOld.add(key); handledNew.add(key);
      if (changes.length === 0) { unchanged++; continue; }
      const hasBreaking = changes.some(c => c.kind === 'breaking');
      const entry = { type: hasBreaking ? 'breaking' : 'changed', endpoint: { method: String(newEp.method).toUpperCase(), url: newEp.url, name: newEp.name, title: newEp.title }, changes };
      if (hasBreaking) breaking.push(entry); else changed.push(entry);
    }
  }

  // detect method changes on same URL
  for (const [url, olds] of oldByUrl.entries()) {
    const news = newByUrl.get(url);
    if (!news) continue;
    for (const o of olds) {
      if (handledOld.has(o.key)) continue;
      for (const n of news) {
        if (handledNew.has(n.key)) continue;
        // same URL, different method -> breaking
        breaking.push({
          type: 'breaking',
          endpoint: { method: String(n.ep.method).toUpperCase(), url: n.ep.url, name: n.ep.name, title: n.ep.title },
          changes: [{ field: 'method', kind: 'breaking', before: String(o.ep.method).toUpperCase(), after: String(n.ep.method).toUpperCase(), message: `Đổi phương thức HTTP từ ${String(o.ep.method).toUpperCase()} → ${String(n.ep.method).toUpperCase()} — breaking` }],
        });
        handledOld.add(o.key); handledNew.add(n.key);
      }
    }
  }

  for (const [key, ep] of oldMap.entries()) {
    if (handledOld.has(key)) continue;
    removed.push({ type: 'removed', endpoint: { method: String(ep.method).toUpperCase(), url: ep.url, name: ep.name, title: ep.title }, changes: [{ field: 'endpoint', kind: 'breaking', before: 'có trong bản cũ', after: 'không còn trong bản mới', message: 'Endpoint đã bị xóa — breaking: ứng dụng đang gọi endpoint này có thể lỗi' }] });
  }
  for (const [key, ep] of newMap.entries()) {
    if (handledNew.has(key)) continue;
    added.push({ type: 'added', endpoint: { method: String(ep.method).toUpperCase(), url: ep.url, name: ep.name, title: ep.title }, changes: [] });
  }

  // removed are breaking
  for (const r of removed) breaking.push(r);

  const summary = {
    breaking: breaking.length,
    changed: changed.length,
    added: added.length,
    removed: removed.length,
    unchanged,
    total: newMap.size,
  };

  return { breaking, changed, added, summary };
}

export function buildChangelogJson({ oldFile, newFile, oldProject, newProject, oldCount, newCount, oldFramework = '', framework = '', oldDate = '', currentDate = '', diff }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    old: { file: oldFile, title: oldProject?.title || '', framework: oldFramework || null, count: oldCount, date: oldDate || null },
    current: { file: newFile, title: newProject?.title || '', framework: framework || null, count: newCount, date: currentDate || null },
    summary: diff.summary,
    changes: { breaking: diff.breaking, changed: diff.changed, added: diff.added },
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildChangelogHtml(changelog) {
  const rows = [];
  const section = (title, items, color) => {
    if (!items.length) return '';
    const trs = items.map(it => {
      const messages = it.changes.map(c => c.message || `${c.field}: ${c.before} → ${c.after}`);
      const ch = messages.map(message => `<div class="change">${esc(message)}</div>`).join('');
      return `<tr><td><strong>${esc(it.endpoint.method)}</strong> <code>${esc(it.endpoint.url)}</code><br><small>${esc(it.endpoint.title || it.endpoint.name || '')}</small></td><td>${ch || '<em>Không có mô tả chi tiết.</em>'}</td></tr>`;
    }).join('');
    return `<h3 style="color:${color}">${esc(title)} (${items.length})</h3><table><thead><tr><th>Endpoint</th><th>Thay đổi</th></tr></thead><tbody>${trs}</tbody></table>`;
  };
  const s = changelog.summary;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Changelog — ${esc(changelog.current.title || 'API')}</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111}table{width:100%;border-collapse:collapse;margin:8px 0 20px}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top}th{background:#f6f6f6}.change{margin:4px 0;padding:7px 9px;background:#fafafa;border-left:3px solid #d1d5db}.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;color:#fff}.b{background:#d92d20}.c{background:#d97706}.a{background:#16a34a}</style></head><body>
<h1>Changelog API</h1>
<p><small>Tạo lúc: ${esc(changelog.generatedAt)}<br>Tài liệu cũ: <code>${esc(changelog.old.file)}</code>${changelog.old.framework ? ` (${esc(changelog.old.framework)})` : ''} — ngày: ${esc(changelog.old.date || 'không có')} — ${changelog.old.count} endpoint<br>Tài liệu hiện tại: <code>${esc(changelog.current.file)}</code>${changelog.current.framework ? ` (${esc(changelog.current.framework)})` : ''} — ngày: ${esc(changelog.current.date || 'không có')} — ${changelog.current.count} endpoint</small></p>
<p><span class="badge b">Breaking: ${s.breaking}</span> <span class="badge c">Changed: ${s.changed}</span> <span class="badge a">Added: ${s.added}</span> <span class="badge" style="background:#6b7280">Removed: ${s.removed}</span></p>
${section('Breaking / Removed', changelog.changes.breaking, '#b91c1c')}
${section('Changed', changelog.changes.changed, '#92400e')}
${section('Added', changelog.changes.added, '#15803d')}
${(!changelog.changes.breaking.length && !changelog.changes.changed.length && !changelog.changes.added.length) ? '<p><em>Không có thay đổi ảnh hưởng API.</em></p>' : ''}
</body></html>`;
}
