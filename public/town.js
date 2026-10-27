(() => {
  'use strict';
  const ACTIVE = new Set(['thinking', 'tool', 'typing']);
  const RESTING = new Set(['idle', 'done', 'interrupted']);
  const ACTIVITY_LABELS = { busy: '忙碌中', idle: '整体闲着', attention: '等待处理', unknown: '状态未明', empty: '暂未入住' };
  function activityOf(members) {
    const result = { total: members.length, busy: 0, attention: 0, resting: 0, unknown: 0, logs: 0, fallback: 0 };
    for (const member of members) {
      const fallback = (member.statusSource || member.source) === 'herdr';
      result[fallback ? 'fallback' : 'logs']++;
      // Consume the server's effective status, AFTER original log timeouts.
      // herdrStatus is intentionally never used for log-linked occupants.
      if (fallback && member.sourceStatus === 'unknown') result.unknown++;
      else if (ACTIVE.has(member.status)) result.busy++;
      else if (member.status === 'waiting' || member.status === 'error') result.attention++;
      else if (RESTING.has(member.status)) result.resting++;
      else result.unknown++;
    }
    result.kind = result.busy ? 'busy' : result.attention ? 'attention' : result.unknown ? 'unknown' : result.total ? 'idle' : 'empty';
    return result;
  }
  function summarize(snapshot) {
    const groups = new Map();
    for (const member of snapshot.sessions) {
      const id = member.teamId || 'ungrouped';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(member);
    }
    const houses = snapshot.teams.map(team => ({ team, activity: activityOf(groups.get(team.id) || []) }));
    const teams = houses.filter(house => house.team.id !== 'ungrouped');
    return { houses, teams: teams.length,
      busyTeams: teams.filter(house => house.activity.kind === 'busy').length,
      idleTeams: teams.filter(house => house.activity.kind === 'idle').length,
      otherTeams: teams.filter(house => !['busy', 'idle'].includes(house.activity.kind)).length,
      workingAgents: activityOf(snapshot.sessions).busy,
      ungroupedAgents: (groups.get('ungrouped') || []).length,
    };
  }
  // Pure homepage aggregation is also exercised by dependency-free tests.
  if (typeof module !== 'undefined' && module.exports) { module.exports = { activityOf, summarize }; return; }
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let data = { sessions: [], teams: [] }, connected = false, summary = summarize(data);
  const houses = new Map();
  const palette = [
    { roof: '#738c70', dark: '#4f6c54', wall: '#f4e9c8', side: '#d9cb9f', trim: '#777c52' },
    { roof: '#b47c59', dark: '#8b5943', wall: '#f2e2c7', side: '#d8c2a3', trim: '#9f754e' },
    { roof: '#698994', dark: '#476874', wall: '#eee8d5', side: '#cecebb', trim: '#667f79' },
    { roof: '#a99a69', dark: '#837741', wall: '#f5ebcd', side: '#d8cb9e', trim: '#948357' },
  ];
  function houseArt(index) {
    const c = palette[index % palette.length];
    // Hand-built vector architecture; all assets and typography stay local.
    return `<svg class="house-illustration" viewBox="0 0 320 250" aria-hidden="true">
      <ellipse cx="160" cy="224" rx="125" ry="16" fill="#bdcba9" opacity=".55"/>
      <path d="M125 219 162 200 211 225 185 244Z" fill="#d8ccb0"/><path d="m145 220 20 10m-7-18 23 12" stroke="#c2b694" stroke-width="2"/>
      <path d="M245 172v39m-7-4h16" stroke="#8b7953" stroke-width="7"/><path d="m243 112-28 66h58z" fill="#88a276"/><path d="m247 98-22 57h44z" fill="#9ab382"/>
      <path d="M45 193v25m-4-4h10" stroke="#927b53" stroke-width="6"/><circle cx="47" cy="179" r="21" fill="#a7b783"/><circle cx="37" cy="175" r="14" fill="#b4c391"/>
      <path d="M72 140 166 167 166 222 72 193Z" fill="${c.wall}"/><path d="M166 167 241 126 241 183 166 222Z" fill="${c.side}"/>
      <path d="M65 142 100 75 174 132 166 173Z" fill="${c.roof}"/><path d="M100 75 174 35 252 124 174 167 174 132Z" fill="${c.dark}"/>
      <path d="m70 137 95 29m-79-61 79 30m-66-50 67 26m-52-24 69 23m-62-36 100 109" fill="none" stroke="#fff" opacity=".12" stroke-width="2"/>
      <path d="m100 75 74 57-8 35-94-28Z" fill="${c.wall}"/><path d="m66 140 34-65 74 57m-74-57 74-40 78 89-78 43" fill="none" stroke="${c.trim}" stroke-width="6" stroke-linejoin="round"/>
      <path d="m107 109 19 6v20l-19-6Z" fill="${c.trim}"/><path class="window-glow" d="m110 113 13 4v13l-13-4Z"/><path d="m117 115v14" stroke="${c.trim}" stroke-width="2"/>
      <path d="M82 155 108 163v27l-26-8Z" fill="${c.trim}"/><path class="window-glow" d="m85 159 20 6v20l-20-6Z"/><path d="m95 162v20m-11-13 22 7" stroke="${c.trim}" stroke-width="2"/>
      <path d="m126 171 23 7v36l-23-7Z" fill="#8f7555"/><path d="m130 176 15 5v15l-15-5Z" fill="#c8c4a1"/><circle cx="143" cy="203" r="1.6" fill="#f2d08a"/>
      <path d="m188 160 24-13v27l-24 13Z" fill="${c.trim}"/><path class="window-glow" d="m191 162 18-10v19l-18 10Z"/><path d="m200 157v19m-10-6 20-11" stroke="${c.trim}" stroke-width="2"/>
      <path d="m211 82 0-41 15-8v46Z" fill="#9b8062"/><path d="m198 72 0-37 13 6v41Z" fill="#b5a07d"/><path d="m195 33 16-8 18 8-18 9Z" fill="#c9b594"/><path d="m201 33 10-5 11 5-11 5Z" fill="#7a705b"/>
      <g class="smoke" fill="#f8f7ed" opacity=".45"><ellipse cx="212" cy="15" rx="8" ry="5"/><ellipse cx="205" cy="2" rx="12" ry="6"/></g>
      <path d="m77 193 83 26m6 3 75-39" stroke="#b4aa84" stroke-width="4"/>
      <path d="M86 191v9m10-6v9m-18-8 28 9" stroke="#c6b98e" stroke-width="3"/>
      <ellipse cx="222" cy="204" rx="14" ry="5" fill="#9db580"/><ellipse cx="227" cy="199" rx="10" ry="7" fill="#99b27b"/>
      <circle cx="222" cy="195" r="2.2" fill="#f0d28d"/><circle cx="230" cy="198" r="2" fill="#e8b599"/>
      <path d="m54 215 4-6 3 7m194-1 4-7 3 6" stroke="#9aaf7a" stroke-width="2" fill="none"/>
    </svg>`;
  }
  function renderHouses() {
    const ids = new Set();
    summary = summarize(data);
    $('houses').dataset.count = data.teams.length;
    $('neighborhood').dataset.rows = Math.ceil(data.teams.length / 2);
    summary.houses.forEach(({ team, activity: a }, index) => {
      ids.add(team.id);
      let house = houses.get(team.id);
      if (!house) {
        house = document.createElement('button'); house.type = 'button'; house.className = 'house';
        house.dataset.testid = 'house'; house.dataset.teamId = team.id;
        house.innerHTML = `${houseArt(index)}<span class="house-sign"></span>`;
        house.addEventListener('click', () => navigate(team.id));
        houses.set(team.id, house); $('houses').appendChild(house);
      }
      house.dataset.busy = a.busy > 0;
      house.dataset.activity = a.kind;
      house.dataset.stale = team.presence === 'stale' || !connected;
      house.dataset.working = a.busy;
      house.dataset.total = a.total;
      house.style.setProperty('--house-size', String(Math.min(1.06, .79 + Math.sqrt(a.total) * .07)));
      const name = team.name || team.label || team.id;
      const note = a.attention ? `${a.attention} 位等待处理` : a.unknown ? `${a.unknown} 位状态未明` : a.kind === 'idle' ? '暂无运行中的任务' : a.kind === 'empty' ? '房子还在，等成员回来' : '窗灯已亮，任务进行中';
      const source = a.fallback ? `${a.logs} 日志 · ${a.fallback} Herdr 回退` : a.total ? '状态来源：会话日志' : '暂无成员状态';
      house.setAttribute('aria-label', `进入 ${name} · ${ACTIVITY_LABELS[a.kind]} · ${a.busy}/${a.total} 正在忙 · ${note} · ${source}`);
      const content = `<span class="house-number"><span>${escape(team.id)} / ${team.id === 'ungrouped' ? 'SESSION HOUSE' : 'TEAM HOUSE'}</span><span class="house-arrow" aria-hidden="true">↗</span></span>
        <span class="house-name">${escape(name)}</span>
        <span class="house-meta"><span class="status-chip" data-status="${a.kind}">${ACTIVITY_LABELS[a.kind]}</span><span class="busy-ratio"><b>${a.busy}/${a.total}</b> 正在忙</span></span>
        <span class="busy-meter" aria-hidden="true"><span style="width:${a.total ? a.busy / a.total * 100 : 0}%"></span></span>
        <span class="house-note">${note}</span><span class="house-source">${source}${team.presence === 'stale' ? ' · 身份过期' : ''}</span>`;
      const sign = house.querySelector('.house-sign');
      if (sign.innerHTML !== content) sign.innerHTML = content;
      // Preserve nodes (focus/animation) but keep a changed workspace order correct.
      if ($('houses').children[index] !== house) $('houses').insertBefore(house, $('houses').children[index] || null);
    });
    for (const [id, node] of houses) if (!ids.has(id)) { node.remove(); houses.delete(id); }
    $('empty').hidden = data.teams.length > 0;
    $('busy-team-count').textContent = summary.busyTeams;
    $('idle-team-count').textContent = summary.idleTeams;
    $('working-count').textContent = summary.workingAgents;
    $('overview-note').textContent = `${summary.teams} 个团队${summary.otherTeams ? ` · ${summary.otherTeams} 个待处理 / 未明 / 空屋` : ''}${summary.ungroupedAgents ? ` · 另有 ${summary.ungroupedAgents} 位未分组成员` : ''}`;
  }
  function navigate(id) {
    // A house opens the original page, not a second implementation of Office.
    location.assign(`/office?team=${encodeURIComponent(id)}`);
  }
  function receive(next) {
    if (!next || !Array.isArray(next.sessions)) return;
    data = next;
    if (!Array.isArray(data.teams)) data.teams = [];
    if (!data.teams.length && data.sessions.length) data.teams = [{ id: 'ungrouped', name: '未分组', presence: 'fresh' }];
    renderHouses();
    let fromHash = null;
    try { fromHash = new URLSearchParams(location.hash.slice(1)).get('team'); } catch {}
    if (fromHash && data.teams.some(t => t.id === fromHash)) navigate(fromHash);
    updateConnection();
  }
  function updateConnection() {
    const stale = data.source?.presence === 'stale' || !connected;
    $('connection').dataset.live = !stale;
    $('connection').textContent = stale ? '连接中 / 状态可能过期' : '实时同步 · 日志优先';
    $('source-warning').hidden = !stale;
    $('source-warning').textContent = data.source?.error || '连接暂不可用，保留最后一次状态；连接恢复后会自动更新。';
    $('summary-freshness').textContent = stale ? '上次快照 · 可能过期' : '日志优先 · 实时概览';
    for (const { team } of summary.houses) houses.get(team.id).dataset.stale = !connected || team.presence === 'stale';
  }
  const events = new EventSource('/events');
  events.onopen = () => { connected = true; updateConnection(); };
  events.onmessage = event => { try { connected = true; receive(JSON.parse(event.data)); } catch (error) { console.error('Invalid town snapshot', error.message); } };
  events.onerror = () => { connected = false; updateConnection(); };
  window.addEventListener('pagehide', () => events.close());
  window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
  // Read-only diagnostics for local verification; not an agent control surface.
  window.teamTown = { get snapshot() { return data; }, get summary() { return summary; } };
})();
