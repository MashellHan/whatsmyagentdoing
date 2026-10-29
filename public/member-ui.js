// Local room details. Poll only the expanded member; commands never enter the
// shared SSE snapshot, browser storage, or Cloudflare assets.
const HEADERS = { 'x-agent-office-rule-read': '1' };
const INTERVAL = 1500;
const REASONS = {
  'no-session-id': '此成员尚未提供会话 ID，暂时无法读取最近活动。',
  'ambiguous-session': '发现多个同 ID 的日志，暂时无法确认该成员的活动记录。',
  'log-unavailable': '尚未找到此成员的本机会话日志。',
};
function node(tag, className, text) {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function eligible(team) {
  const query = new URLSearchParams(location.search);
  return ['localhost', '127.0.0.1'].includes(location.hostname) && /^\/office\/?$/.test(location.pathname) &&
    team && team !== 'ungrouped' && query.get('team') === team && query.get('pip') !== '1' && !document.body.classList.contains('pip');
}
export function mountMemberUI({ team, rules }) {
  if (!eligible(team)) return null;
  const stylesheet = node('link', ''); stylesheet.rel = 'stylesheet'; stylesheet.href = '/member-ui.css'; document.head.append(stylesheet);
  const roster = document.getElementById('members');
  let members = [], active = null, timer = null, controller = null, generation = 0, sequence = 0, left = false;
  const canPoll = () => !left && eligible(team) && active?.row.isConnected && !document.hidden && !document.getElementById('rules-dialog')?.open;
  function cancel() { generation++; clearTimeout(timer); timer = null; controller?.abort(); controller = null; }
  function close() {
    cancel();
    if (active) { active.panel.remove(); active.row.querySelector('.member-summary')?.setAttribute('aria-expanded', 'false'); }
    active = null;
  }
  function content(data) {
    const signature = JSON.stringify([data.available, data.reason, data.entries]);
    active.status.textContent = data.available ? `实时 · ${data.entries.length} 条` : '尚未关联';
    if (active.signature === signature) return;
    active.signature = signature;
    const scroll = active.list.scrollTop;
    const atBottom = active.list.scrollHeight - scroll - active.list.clientHeight < 24;
    active.list.replaceChildren();
    if (!data.available) {
      active.list.append(node('li', 'member-activity-note', REASONS[data.reason] || '此成员的最近活动暂不可用。'));
      active.status.textContent = '尚未关联'; return;
    }
    if (!data.entries.length) active.list.append(node('li', 'member-activity-note', '暂无活动记录。'));
    for (const entry of data.entries) {
      const row = node('li', 'member-command');
      const heading = node('div', 'member-command-heading');
      const date = entry.at ? new Date(entry.at) : null;
      const time = node('time', '', date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '时间未记录');
      if (date && Number.isFinite(date.getTime())) { time.dateTime = date.toISOString(); time.title = date.toLocaleString(); }
      heading.append(node('span', '', entry.tool), time);
      const code = node('pre', '', entry.text);
      row.append(heading, code);
      if (entry.truncated) row.append(node('span', 'member-truncated', '内容已截断'));
      active.list.append(row);
    }
    active.status.textContent = `实时 · ${data.entries.length} 条`;
    // Stay at the newest command unless the user has scrolled back to read.
    active.list.scrollTop = atBottom || !active.loaded ? active.list.scrollHeight : scroll;
    active.loaded = true;
  }
  async function poll() {
    if (!canPoll()) return;
    cancel(); const version = generation, key = active.key;
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 5000);
    try {
      const response = await fetch(`/api/members/activity?${new URLSearchParams({ team, member: key })}`, {
        headers: HEADERS, signal: request.signal, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      });
      const data = await response.json();
      if (version !== generation || active?.key !== key || !canPoll()) return;
      if (!response.ok) throw new Error(data.error === 'scope_stale' ? '团队信息暂时过期，正在重试…' : '读取暂不可用，正在重试…');
      if (data.member !== key || typeof data.available !== 'boolean' || !Array.isArray(data.entries) || data.entries.length > 30 ||
          data.entries.some(e => !e || typeof e.text !== 'string' || Array.from(e.text).length > 360 || typeof e.tool !== 'string' || e.tool.length > 160)) throw new Error('读取结果不可用，正在重试…');
      content(data);
    } catch (error) {
      if (version !== generation || active?.key !== key || !canPoll()) return;
      active.signature = null;
      active.list.replaceChildren(node('li', 'member-activity-note', error.name === 'AbortError' ? '读取超时，正在重试…' : '最近活动暂不可用，正在重试…'));
      active.status.textContent = '重连中';
    } finally {
      clearTimeout(deadline);
      if (version === generation) { controller = null; if (canPoll()) timer = setTimeout(poll, INTERVAL); }
    }
  }
  function open(member, row) {
    close();
    const panel = node('section', 'member-activity'); panel.id = `member-activity-${++sequence}`;
    panel.setAttribute('aria-label', `${member.displayName || member.id} 的最近活动`);
    const heading = node('div', 'member-activity-heading'), status = node('span', 'member-activity-status', '连接中');
    status.setAttribute('role', 'status');
    heading.append(node('strong', '', '最近活动'), status);
    const list = node('ol', 'member-commands'); list.tabIndex = 0; list.setAttribute('aria-label', '最近活动记录');
    list.append(node('li', 'member-activity-note', '正在读取…'));
    panel.append(heading, list, node('p', 'member-activity-foot', '每 1.5 秒刷新 · 最多 30 条 · 每条最多 360 字'));
    row.append(panel);
    const toggle = row.querySelector('.member-summary'); toggle.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-controls', panel.id);
    active = { key: member.key, row, panel, status, list, signature: null, loaded: false };
    void poll();
  }
  roster.addEventListener('click', event => {
    const row = event.target.closest('.team-member');
    if (!row || !eligible(team)) return;
    const member = members.find(m => m.key === row.dataset.key);
    if (!member) return;
    const trigger = event.target.closest('.member-rules');
    if (trigger) { rules?.openMember(member.key, member.displayName || member.id, trigger); return; }
    if (!event.target.closest('[data-member-toggle]')) return;
    if (active?.key === member.key) close(); else open(member, row);
  });
  function visibility() {
    cancel();
    if (canPoll()) void poll();
    else if (active) active.status.textContent = '已暂停';
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('rules-visibility', visibility);
  window.addEventListener('pagehide', () => { left = true; close(); });
  window.addEventListener('pageshow', () => { left = false; });
  window.addEventListener('popstate', () => { if (!eligible(team)) close(); });
  return {
    sync(next) {
      members = next;
      if (active && (!next.some(m => m.key === active.key) || !active.row.isConnected)) close();
      for (const row of roster.querySelectorAll('.team-member')) {
        const toggle = row.querySelector('.member-summary');
        toggle.setAttribute('aria-expanded', String(active?.key === row.dataset.key));
        toggle.title = '点击展开或收起最近活动';
        if (rules && !row.querySelector('.member-rules')) {
          const entry = node('button', 'member-rules', '▤ 准则 / Skills'); entry.type = 'button';
          entry.setAttribute('aria-haspopup', 'dialog');
          row.append(entry);
        }
      }
      rules?.syncMembers(next);
    },
  };
}
