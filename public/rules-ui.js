// Local, on-demand rules reader. No content persistence, SSE, executable Markdown,
// dynamic document URLs, or third-party parser. Files are identified only by API IDs.
const MAX_CONTENT = 256 * 1024;
const HEADERS = { 'x-agent-office-rule-read': '1' };
const ERROR_TEXT = {
  403: '本机守则阅读不可用或请求未获允许。',
  404: '文件或团队不可用，请刷新列表重新选择。',
  409: '文件或仓库范围已变化，请刷新列表重新选择。',
  413: '文件过大，无法完整读取。',
  422: '文件不是支持的 UTF-8 文本，无法读取。',
  429: '读取过于频繁，请稍后手动重试。',
  503: '仓库范围或本地读取服务暂不可用，请稍后重试。',
};
const CODE_TEXT = {
  no_scope: '尚未确认该团队的仓库范围。',
  scope_not_ready: '尚未确认该团队的仓库范围。',
  scope_unavailable: '尚未确认该团队的仓库范围。',
  scope_stale: '仓库范围信息已过期，请稍后刷新列表。',
  scope_changed: ERROR_TEXT[409], file_changed: ERROR_TEXT[409],
  file_too_large: ERROR_TEXT[413], invalid_utf8: ERROR_TEXT[422],
};
function node(tag, className = '', text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  if (tag === 'pre') el.tabIndex = 0;
  return el;
}
function button(text, className = '') {
  const el = node('button', className, text); el.type = 'button'; return el;
}

// Intentionally a small Markdown dialect, not HTML parsing or sanitization.
// Unsupported syntax stays literal. The only inline tags are code/strong/em/span.
function inline(parent, text) {
  // Long/pathological paragraphs stay complete and literal rather than spending
  // unbounded time looking for unmatched Markdown delimiters.
  if (text.length > 4096) { parent.append(document.createTextNode(text)); return; }
  const tokens = /(!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let previous = 0, matches = 0;
  for (const match of text.matchAll(tokens)) {
    if (++matches > 2000) break; // Preserve the remainder as text, not partial content.
    parent.append(document.createTextNode(text.slice(previous, match.index)));
    const token = match[0];
    const wordUnderscore = token[0] === '_' &&
      (/[\p{L}\p{N}]/u.test(text[match.index - 1] || '') || /[\p{L}\p{N}]/u.test(text[match.index + token.length] || ''));
    if (wordUnderscore) {
      parent.append(document.createTextNode(token));
    } else if (token.startsWith('![')) {
      parent.append(node('span', 'rules-image-disabled', `［图片已禁用：${token.slice(2, token.indexOf(']'))}］`));
    } else if (token.startsWith('[')) {
      // No <a>, href, link previews or URL normalization; even local links are inert.
      const end = token.indexOf(']');
      parent.append(node('span', 'rules-link-disabled', `${token.slice(1, end)}（${token.slice(end + 2, -1)}）`));
    } else {
      const double = token.startsWith('**') || token.startsWith('__');
      const count = double ? 2 : 1;
      parent.append(node(token[0] === '`' ? 'code' : double ? 'strong' : 'em', '', token.slice(count, -count)));
    }
    previous = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(previous)));
}
export function renderMarkdown(content) {
  const fragment = document.createDocumentFragment();
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 10000) {
    fragment.append(node('p', 'rules-notice', '格式行数较多，以下完整显示原文。'), node('pre', 'rules-raw', content));
    return fragment;
  }
  const startsBlock = line => /^(?: {0,3}(?:`{3,}|~{3,}|#{1,6}\s)|\s*(?:[-+*]|\d+[.)])\s|>\s?)/.test(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const code = [], closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      i++;
      while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = node('pre'); pre.append(node('code', '', code.join('\n'))); fragment.append(pre); continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) { const h = node(`h${heading[1].length}`); inline(h, heading[2]); fragment.append(h); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { fragment.append(node('hr')); i++; continue; }
    const item = line.match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
    if (item) {
      const ordered = /^\d/.test(item[1]), list = node(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const next = lines[i].match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        const li = node('li'); inline(li, next[2]); list.append(li); i++;
      }
      fragment.append(list); continue;
    }
    if (/^>\s?/.test(line)) { const quote = node('blockquote'); inline(quote, line.replace(/^>\s?/, '')); fragment.append(quote); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
    const p = node('p'); inline(p, paragraph.join('\n')); fragment.append(p);
  }
  return fragment;
}

function eligible(team) {
  const query = new URLSearchParams(location.search);
  return ['localhost', '127.0.0.1'].includes(location.hostname) && /^\/office\/?$/.test(location.pathname) &&
    team && team !== 'ungrouped' && query.get('team') === team && query.get('pip') !== '1' && !document.body.classList.contains('pip');
}
function requestError(status, code) {
  const message = Object.hasOwn(CODE_TEXT, code) ? CODE_TEXT[code] : ERROR_TEXT[status] || '读取失败，请稍后手动重试。';
  return Object.assign(new Error(message), { status });
}
async function readJSON(path, signal) {
  const response = await fetch(path, { headers: HEADERS, signal, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw requestError(response.status, typeof value?.error === 'string' ? value.error : '');
  if (!value || typeof value !== 'object') throw requestError(503);
  return value;
}

export function mountRulesUI({ team, teamName = () => team, beforeOpen = () => {} }) {
  if (!eligible(team) || document.getElementById('rules-entry')) return;
  const stylesheet = node('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/rules-ui.css';
  document.head.append(stylesheet);
  const entry = button('团队守则', 'btn rules-entry'); entry.id = 'rules-entry'; entry.setAttribute('aria-haspopup', 'dialog');
  const icon = node('span', 'rules-entry-icon', '▤'); icon.setAttribute('aria-hidden', 'true'); entry.prepend(icon);
  document.getElementById('teamScope').after(entry);
  const dialog = node('dialog', 'rules-dialog'); dialog.id = 'rules-dialog'; dialog.setAttribute('aria-labelledby', 'rules-title');
  const header = node('header', 'rules-header'), heading = node('div', 'rules-heading');
  const title = node('h2', '', '团队守则'); title.id = 'rules-title';
  const teamLabel = node('p', 'rules-team');
  heading.append(title, teamLabel);
  const close = button('关闭', 'rules-close'); close.setAttribute('aria-label', '关闭团队守则');
  header.append(heading, node('span', 'rules-local', '只读 · 仅本机'), close);
  const shell = node('div', 'rules-shell'), sidebar = node('aside', 'rules-sidebar'); sidebar.setAttribute('aria-label', '规则文件列表');
  const listTools = node('div', 'rules-list-tools'), refresh = button('刷新列表');
  const countLabel = node('span', 'rules-count'); listTools.append(refresh, countLabel);
  const listMessage = node('p', 'rules-notice'), files = node('div', 'rules-files');
  const warning = node('p', 'rules-warning'); warning.hidden = true;
  sidebar.append(listTools, warning, listMessage, files);
  const reader = node('section', 'rules-reader'); reader.setAttribute('aria-label', '守则阅读区');
  const toolbar = node('div', 'rules-reader-tools'), back = button('← 文件列表', 'rules-back');
  const modes = node('div', 'rules-modes'), rendered = button('阅读'), rawButton = button('原文');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '正文显示方式'); modes.append(rendered, rawButton);
  const reread = button('重新读取'); toolbar.append(back, modes, reread);
  const docTitle = node('h3', 'rules-path'); docTitle.tabIndex = -1;
  const docMeta = node('p', 'rules-meta'), article = node('article', 'rules-body');
  reader.append(toolbar, docTitle, docMeta, article); shell.append(sidebar, reader);
  const status = node('p', 'rules-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  dialog.append(header, shell, status); document.body.append(dialog);
  let generation = 0, controller = null, selected = null, content = '', mode = 'reading', hasContent = false;
  let fileEntries = [], listScroll = 0;
  function cancel() { generation++; controller?.abort(); controller = null; }
  function clearDocument() {
    content = ''; hasContent = false; mode = 'reading';
    docTitle.textContent = ''; docMeta.textContent = ''; article.replaceChildren();
    rendered.disabled = rawButton.disabled = reread.disabled = true;
    rendered.setAttribute('aria-pressed', 'true'); rawButton.setAttribute('aria-pressed', 'false');
    reader.setAttribute('aria-busy', 'false');
  }
  function reset() {
    cancel(); clearDocument(); selected = null; fileEntries = []; files.replaceChildren();
    listMessage.textContent = ''; warning.textContent = ''; warning.hidden = true;
    countLabel.textContent = ''; teamLabel.textContent = ''; status.textContent = '';
    sidebar.setAttribute('aria-busy', 'false'); dialog.dataset.pane = 'list'; listScroll = 0;
  }
  function dismiss(returnFocus = true) {
    reset();
    if (dialog.open) dialog.close();
    if (returnFocus && entry.isConnected) entry.focus({ preventScroll: true });
  }
  function current(version) { return version === generation && dialog.open && eligible(team); }
  function start() { cancel(); controller = new AbortController(); return { version: generation, signal: controller.signal }; }
  function showDocument() {
    article.replaceChildren();
    rendered.setAttribute('aria-pressed', String(mode === 'reading'));
    rawButton.setAttribute('aria-pressed', String(mode === 'raw'));
    if (!content) article.append(node('p', 'rules-notice', '此文件为空。'));
    else if (mode === 'raw') article.append(node('pre', 'rules-raw', content));
    else {
      try { article.append(renderMarkdown(content)); }
      catch { article.replaceChildren(node('p', 'rules-notice', '格式无法展开，以下完整显示原文。'), node('pre', 'rules-raw', content)); }
    }
  }
  function showError(target, error, retry) {
    target.replaceChildren(node('p', 'rules-notice', error.message && error.status ? error.message : '连接失败，请稍后手动重试。'));
    const action = button([404,409].includes(error.status) ? '刷新列表' : '重试');
    action.addEventListener('click', [404,409].includes(error.status) ? loadList : retry); target.append(action);
    status.textContent = '读取未完成。';
  }
  async function loadList() {
    if (!dialog.open || !eligible(team)) { dismiss(false); return; }
    const { version, signal } = start();
    clearDocument(); selected = null; fileEntries = []; files.replaceChildren();
    dialog.dataset.pane = 'list'; countLabel.textContent = ''; warning.hidden = true; warning.textContent = '';
    listMessage.textContent = '正在查找规则文件…'; article.append(node('p', 'rules-notice', '选择一个文件阅读；内容不会自动发送给 agent。'));
    sidebar.setAttribute('aria-busy', 'true'); status.textContent = '正在查找规则文件…';
    try {
      const data = await readJSON(`/api/rules?${new URLSearchParams({ team })}`, signal);
      if (!current(version)) return;
      if (!Array.isArray(data.files) || data.files.length > 128 || !Number.isInteger(data.scopeCount) || data.scopeCount < 0 ||
        data.files.some(f => !f || !/^[a-f0-9]{40}$/.test(f.id) || typeof f.path !== 'string' || typeof f.scope !== 'string' || !Number.isFinite(f.size) || f.size < 0)) throw requestError(503);
      listMessage.textContent = data.scopeCount === 0 ? '尚未确认该团队的仓库范围。' : data.files.length ? '' : '此范围内未找到规则文件。候选包括 AGENTS.md、TEAMS.md、TEAM.md、CLAUDE.md、GEMINI.md、.codex/AGENTS.md 与 docs/TEAM*.md。';
      countLabel.textContent = `${data.scopeCount} 个范围 · ${data.files.length} 个文件`;
      if (Array.isArray(data.warnings) && data.warnings.length) {
        warning.hidden = false;
        warning.textContent = data.warnings.some(code => ['no_scope','scope_not_ready','scope_unavailable'].includes(code))
          ? '尚未确认部分仓库范围；下方仅显示已确认的项目。' : '部分范围或候选文件未列出，或发现过程有提示；列表不代表全部守则。';
      }
      const groups = new Map();
      for (const file of data.files) {
        if (!groups.has(file.scope)) {
          const group = node('div', 'rules-file-group'); group.append(node('h3', '', file.scope)); files.append(group); groups.set(file.scope, group);
        }
        const item = button('', 'rules-file');
        const mark = node('span', 'rules-file-mark', '▤'); mark.setAttribute('aria-hidden', 'true');
        item.append(mark, node('span', 'rules-file-path', file.path), node('small', '', `${file.size} B · ${file.scope}`));
        item.setAttribute('aria-label', `${file.path} · ${file.scope} · ${file.size} 字节`);
        item.setAttribute('aria-current', 'false'); item.addEventListener('click', () => loadFile(file));
        groups.get(file.scope).append(item); fileEntries.push({ file, item });
      }
      status.textContent = data.files.length ? `已列出 ${data.files.length} 个文件；尚未读取正文。` : listMessage.textContent;
    } catch (error) { if (current(version) && error.name !== 'AbortError') { listMessage.textContent = ''; showError(files, error, loadList); } }
    finally { if (current(version)) { controller = null; sidebar.setAttribute('aria-busy', 'false'); } }
  }
  async function loadFile(file) {
    if (!dialog.open || !eligible(team)) { dismiss(false); return; }
    const { version, signal } = start(); clearDocument(); selected = file;
    if (dialog.dataset.pane !== 'document') listScroll = sidebar.scrollTop;
    dialog.dataset.pane = 'document'; reader.scrollTop = 0;
    for (const entry of fileEntries) {
      const active = entry.file.id === file.id;
      entry.item.setAttribute('aria-current', String(active)); entry.item.querySelector('.rules-file-mark').textContent = active ? '✓' : '▤';
    }
    docTitle.textContent = file.path; docMeta.textContent = file.scope;
    article.append(node('p', 'rules-notice', '正在读取…')); reader.setAttribute('aria-busy', 'true'); status.textContent = '正在读取…';
    docTitle.focus({ preventScroll: true });
    try {
      const data = await readJSON(`/api/rules/file?${new URLSearchParams({ team, id: file.id })}`, signal);
      if (!current(version) || selected?.id !== file.id) return;
      if (typeof data.content !== 'string' || data.path !== file.path || data.scope !== file.scope) throw requestError(409);
      if (data.content.length > MAX_CONTENT || new TextEncoder().encode(data.content).length > MAX_CONTENT) throw requestError(413);
      content = data.content; hasContent = true;
      const readAt = new Date(data.readAt);
      docMeta.textContent = `${data.scope} · ${Number.isNaN(readAt.getTime()) ? '本次读取' : `读取于 ${readAt.toLocaleString()}`}`;
      rendered.disabled = rawButton.disabled = reread.disabled = false;
      showDocument(); status.textContent = content ? '全文已读取；图片与链接已禁用，内容不会执行或应用。' : '此文件为空。';
    } catch (error) { if (current(version) && error.name !== 'AbortError') { content = ''; hasContent = false; showError(article, error, () => loadFile(file)); } }
    finally { if (current(version)) { controller = null; reader.setAttribute('aria-busy', 'false'); } }
  }
  entry.addEventListener('click', () => {
    if (!eligible(team)) return;
    beforeOpen(); reset(); teamLabel.textContent = teamName(); dialog.showModal(); close.focus(); loadList();
  });
  close.addEventListener('click', () => dismiss());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const stops = [...dialog.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(el => el.checkVisibility());
    const first = stops[0], last = stops.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  refresh.addEventListener('click', loadList);
  back.addEventListener('click', () => {
    cancel(); clearDocument(); dialog.dataset.pane = 'list'; sidebar.scrollTop = listScroll;
    const prior = fileEntries.find(entry => entry.file.id === selected?.id)?.item; selected = null;
    for (const entry of fileEntries) { entry.item.setAttribute('aria-current', 'false'); entry.item.querySelector('.rules-file-mark').textContent = '▤'; }
    (prior || refresh).focus({ preventScroll: true }); status.textContent = '选择文件后才读取正文。';
  });
  rendered.addEventListener('click', () => { if (hasContent) { mode = 'reading'; showDocument(); } });
  rawButton.addEventListener('click', () => { if (hasContent) { mode = 'raw'; showDocument(); } });
  reread.addEventListener('click', () => { if (selected) loadFile(selected); });
  window.addEventListener('pagehide', () => dismiss(false));
  window.addEventListener('pageshow', event => { if (event.persisted) dismiss(false); });
  window.addEventListener('popstate', () => { if (!eligible(team)) { dismiss(false); entry.hidden = true; } });
  reset();
}
