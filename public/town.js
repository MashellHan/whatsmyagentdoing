(() => {
  'use strict';
  const ACTIVE = new Set(['thinking', 'tool', 'typing']);
  const RESTING = new Set(['idle', 'done', 'interrupted']);
  const ACTIVITY_LABELS = { busy: '忙碌中', idle: '整体闲着', attention: '等待处理', unknown: '状态未明', empty: '暂未入住' };
  const ACTIVITY_SYMBOLS = { busy: '↻', idle: 'Zzz', attention: '!', unknown: '?', empty: '—' };
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
  let data = { sessions: [], teams: [] }, connected = false, loaded = false, summary = summarize(data);
  let paused = false, artSerial = 0, layoutFrame = 0;
  const houses = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const singleColumn = matchMedia('(max-width: 760px)');
  let layout = 'compact';
  try { if (localStorage.getItem('agent-office-town-layout') === 'wide') layout = 'wide'; } catch {}
  function updateLayout() {
    document.body.dataset.layout = layout;
    for (const button of $('townLayout').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
    scheduleLayout();
  }
  const clock = '<svg class="freshness-clock" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>';
  const isStale = team => !connected || data.source?.presence === 'stale' || team.presence === 'stale';
  // Observe natural content, never the grid rows stretched by our measurement.
  const contentObserver = new ResizeObserver(scheduleLayout);
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(measureLayout);
  }
  function measureLayout() {
    layoutFrame = 0;
    const neighborhood = $('neighborhood');
    const columns = getComputedStyle($('houses')).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
    neighborhood.dataset.columns = columns;
    neighborhood.dataset.rows = Math.ceil(houses.size / columns);
    let height = parseFloat(getComputedStyle(neighborhood).getPropertyValue('--lot-min-height'));
    for (const house of houses.values()) {
      const offset = parseFloat(getComputedStyle(house).getPropertyValue('--lot-offset')) || 0;
      height = Math.max(height, house.offsetHeight + offset + 8);
    }
    const value = `${Math.ceil(height)}px`;
    if (neighborhood.style.getPropertyValue('--lot-height') !== value) neighborhood.style.setProperty('--lot-height', value);
  }
  function roleSummary(teamId) {
    const counts = { leader: 0, dev: 0, designer: 0 };
    for (const session of data.sessions) {
      if ((session.teamId || 'ungrouped') === teamId && Object.hasOwn(counts, session.role)) counts[session.role]++;
    }
    const roles = Object.entries(counts).filter(([, count]) => count).map(([role, count]) => `${role} ${count}`);
    return roles.length ? `角色：${roles.join(' · ')}` : '';
  }
  function updateMotion() {
    document.body.dataset.motionStatic = reducedMotion.matches || paused;
    $('motion-toggle').hidden = reducedMotion.matches;
    $('motion-toggle').setAttribute('aria-pressed', String(paused));
    $('motion-toggle').textContent = paused ? '恢复小镇动效' : '暂停小镇动效';
    $('motion-reason').textContent = reducedMotion.matches ? '已按系统设置减少动态效果' : paused ? '动效已暂停；状态继续同步' : '';
    for (const { team } of summary.houses) houses.get(team.id).dataset.static = reducedMotion.matches || paused || isStale(team);
  }
  const palette = [
    { roof: '#738c70', dark: '#4f6c54', wall: '#f4e9c8', side: '#d9cb9f', trim: '#777c52' },
    { roof: '#b47c59', dark: '#8b5943', wall: '#f2e2c7', side: '#d8c2a3', trim: '#9f754e' },
    { roof: '#698994', dark: '#476874', wall: '#eee8d5', side: '#cecebb', trim: '#667f79' },
    { roof: '#a99a69', dark: '#837741', wall: '#f5ebcd', side: '#d8cb9e', trim: '#948357' },
  ];
  function houseArt(index) {
    const c = palette[index % palette.length];
    const clipId = `town-window-${++artSerial}`;
    const lightId = `${clipId}-light`;
    // Hand-built vector architecture; all assets and typography stay local.
    return `<svg class="house-illustration" viewBox="0 0 320 250" aria-hidden="true">
      <defs><clipPath id="${clipId}"><path d="m83 157 26 8v26l-26-8Z"/></clipPath><radialGradient id="${lightId}"><stop stop-color="#ffd16c" stop-opacity=".9"/><stop offset=".5" stop-color="#ffd16c" stop-opacity=".4"/><stop offset="1" stop-color="#ffd16c" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="160" cy="224" rx="125" ry="16" fill="#bdcba9" opacity=".55"/>
      <g class="lot-garden">
        <path d="M5 195Q5 176 29 181L64 199Q66 221 41 222L15 212Z" fill="#b4c69b" stroke="#9db285"/>
        <path d="m11 202 3-7 3 8m8 7 2-7 3 7m10-13 3-6 2 7m-15-8 2-6 3 7m11 14 3-7 3 7" fill="none" stroke="#8fa778" stroke-width="1.5"/>
        <ellipse cx="280" cy="205" rx="29" ry="13" fill="#b8cba0"/>
        <g class="shrubs" fill="#7e9c69" stroke="#6e8c5d" stroke-width=".7"><ellipse cx="16" cy="193" rx="12" ry="10"/><ellipse cx="28" cy="189" rx="11" ry="12"/><ellipse cx="40" cy="196" rx="10" ry="9"/><ellipse cx="286" cy="197" rx="14" ry="11"/><ellipse cx="301" cy="199" rx="10" ry="9"/></g>
        <g fill="#a5bd8d"><ellipse cx="13" cy="190" rx="6" ry="4"/><ellipse cx="25" cy="184" rx="5" ry="6"/><ellipse cx="283" cy="192" rx="7" ry="4"/></g>
        <g class="flower-bed"><path d="m268 224 23 8 16-8-24-8Z" fill="#cbb08b" stroke="#ab8e69"/><path d="m272 223 19 6 11-5-19-6Z" fill="#8da276"/><path d="m276 222v-5m10 8v-8m11 7v-6" stroke="#6e8859" stroke-width="2"/><g fill="#eee0ad"><circle cx="276" cy="217" r="3"/><circle cx="297" cy="218" r="3"/></g><circle cx="286" cy="217" r="3" fill="#d9b7a0"/></g>
      </g>
      <path d="M125 219 162 200 211 225 185 244Z" fill="#d8ccb0"/><path d="m145 220 20 10m-7-18 23 12" stroke="#c2b694" stroke-width="2"/>
      <path d="M245 172v39m-7-4h16" stroke="#8b7953" stroke-width="7"/><path d="m243 112-28 66h58z" fill="#88a276"/><path d="m247 98-22 57h44z" fill="#9ab382"/>
      <path d="M45 193v25m-4-4h10" stroke="#927b53" stroke-width="6"/><circle cx="47" cy="179" r="21" fill="#a7b783"/><circle cx="37" cy="175" r="14" fill="#b4c391"/>
      <path d="M72 140 166 167 166 222 72 193Z" fill="${c.wall}"/><path d="M166 167 241 126 241 183 166 222Z" fill="${c.side}"/>
      <path d="M65 142 100 75 174 132 166 173Z" fill="${c.roof}"/><path d="M100 75 174 35 252 124 174 167 174 132Z" fill="${c.dark}"/>
      <path d="m70 137 95 29m-79-61 79 30m-66-50 67 26m-52-24 69 23m-62-36 100 109" fill="none" stroke="#fff" opacity=".12" stroke-width="2"/>
      <path d="m100 75 74 57-8 35-94-28Z" fill="${c.wall}"/><path d="m66 140 34-65 74 57m-74-57 74-40 78 89-78 43" fill="none" stroke="${c.trim}" stroke-width="6" stroke-linejoin="round"/>
      <g class="window-light" fill="url(#${lightId})"><ellipse cx="116" cy="123" rx="26" ry="27"/><ellipse cx="96" cy="175" rx="32" ry="31"/><ellipse cx="202" cy="165" rx="32" ry="36"/><ellipse cx="156" cy="190" rx="17" ry="21"/></g>
      <g class="upper-window"><path d="m103 104 27 8v28l-27-8Z" fill="${c.trim}"/><path class="window-glow" d="m108 110 18 6v18l-18-6Z"/><path d="m117 113v18m-9-12 18 6" stroke="${c.trim}" stroke-width="2"/></g>
      <g class="front-window"><path d="m79 151 34 10v36l-34-10Z" fill="${c.trim}"/><path class="window-glow" d="m83 157 26 8v26l-26-8Z"/><path d="m96 161v26m-13-17 26 8" stroke="${c.trim}" stroke-width="2.2"/><path class="light-highlight" d="m85 159 22 7" stroke-width="1.5"/></g>
      <path d="m126 171 23 7v36l-23-7Z" fill="#8f7555"/><path class="window-glow" d="m130 176 15 5v15l-15-5Z"/><circle cx="143" cy="203" r="1.6" fill="#f2d08a"/>
      <g class="side-window"><path d="m184 153 35-19v42l-35 19Z" fill="${c.trim}"/><path class="window-glow" d="m189 157 25-14v30l-25 14Z"/><path d="m201 150v30m-12-8 25-14" stroke="${c.trim}" stroke-width="2.2"/><path class="light-highlight" d="m191 158 21-12" stroke-width="1.5"/></g>
      <g class="porch-lamp"><path d="m150 181 6-6 7 10Z" fill="#756548"/><path class="lamp-glass" d="m152 182 9 3v13l-9-3Z" stroke="#8a724a" stroke-width="1.6"/><path class="light-highlight" d="m156 184v12" stroke-width="2"/></g>
      <g class="window-clip" clip-path="url(#${clipId})"><g class="window-person" fill="#765c3f"><circle cx="96" cy="172" r="3.5"/><path d="m93 176 6 2 2 9-10-3Z"/></g></g>
      <g class="closed-curtains" fill="#445047" stroke="#2d3932" stroke-width="1">
        <path d="m83 157 26 8v26l-26-8Z"/><path d="m89 159v26m7-24v26m7-24v26"/>
        <path d="m189 157 25-14v30l-25 14Z"/><path d="m195 154v30m7-34v30m6-33v30"/>
        <path d="m108 110 18 6v18l-18-6Z"/><path d="m114 112v18m6-16v18"/>
      </g>
      <g class="roof-pennant"><path d="M153 65V20" stroke="#6e715f" stroke-width="2"/><g class="flag-cloth"><path d="M154 21q10-4 23 1l-5 6 5 6q-13-5-23-1Z" fill="#f5eed9" stroke="#8d8875" stroke-width="1.3"/><path class="flag-mark" d="m158 26 5-1 6 2" fill="none" stroke="#766e58"/></g></g>
      <g class="house-chimney"><path d="m209 40 22-12v46l-22 12Z" fill="#997455"/><path d="m190 31 19 9v46l-19-10Z" fill="#b99b74"/><path d="m191 47 18 8m-18 8 18 8m5-19 16-9m-16 24 16-9" fill="none" stroke="#876c50" stroke-width="1.7"/><path d="m185 29 23-12 29 12-25 15Z" fill="#dcc5a1" stroke="#aa906b" stroke-width="1.2"/><path d="m195 29 14-7 18 7-15 8Z" fill="#746047"/></g>
      <g class="smoke"><g class="puff puff-one"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path class="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g><g class="puff puff-two"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path class="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g><g class="puff puff-three"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path class="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g></g>
      <g class="activity-emblem" fill="#faf6e9" stroke="#777363" stroke-width="1.5"><circle cx="38" cy="110" r="12"/><text class="activity-emblem-text" x="38" y="116" text-anchor="middle" fill="#5c5a4e" stroke="none" font-family="Georgia,serif" font-size="19" font-weight="bold">↻</text></g>
      <path d="m77 193 83 26m6 3 75-39" stroke="#b4aa84" stroke-width="4"/>
      <path d="M86 191v9m10-6v9m-18-8 28 9" stroke="#c6b98e" stroke-width="3"/>
      <ellipse cx="222" cy="204" rx="14" ry="5" fill="#9db580"/><ellipse cx="227" cy="199" rx="10" ry="7" fill="#99b27b"/>
      <circle cx="222" cy="195" r="2.2" fill="#f0d28d"/><circle cx="230" cy="198" r="2" fill="#e8b599"/>
      <path d="m54 215 4-6 3 7m194-1 4-7 3 6" stroke="#9aaf7a" stroke-width="2" fill="none"/>
      <g class="sleeping-cat"><ellipse cx="176" cy="229" rx="19" ry="4" fill="#a8b292" opacity=".5"/><path d="M160 225q0-14 13-12 13 0 14 10-8 6-22 4" fill="#b29a79" stroke="#7e715e"/><path d="m176 217 2-7 6 4 5-3 1 9q-6 7-13 0Z" fill="#c4ae8e" stroke="#7e715e"/><path d="m178 219 3 1m3-1 3-1m-21 4q-13 4-10-5" stroke="#6e6455" fill="none" stroke-linecap="round"/><text class="rest-symbol" x="189" y="208" fill="#635f50" font-size="17" font-family="Georgia,serif" font-weight="bold">Zzz</text></g>
    </svg>`;
  }
  function renderHouses() {
    const ids = new Set();
    summary = summarize(data);
    $('houses').dataset.count = data.teams.length;
    summary.houses.forEach(({ team, activity: a }, index) => {
      ids.add(team.id);
      let house = houses.get(team.id);
      if (!house) {
        house = document.createElement('button'); house.type = 'button'; house.className = 'house';
        house.dataset.testid = 'house'; house.dataset.teamId = team.id;
        house.innerHTML = `<span class="house-art-stage">${houseArt(index)}</span><span class="house-sign"></span>`;
        house.addEventListener('click', () => navigate(team.id));
        houses.set(team.id, house); $('houses').appendChild(house);
        contentObserver.observe(house.querySelector('.house-art-stage'));
        contentObserver.observe(house.querySelector('.house-sign'));
      }
      house.dataset.busy = a.busy > 0;
      house.dataset.activity = a.kind;
      house.dataset.stale = isStale(team);
      house.dataset.working = a.busy;
      house.dataset.total = a.total;
      house.querySelector('.activity-emblem-text').textContent = ACTIVITY_SYMBOLS[a.kind];
      const name = team.name || team.label || team.id;
      const issues = [a.attention ? `${a.attention} 位等待处理` : '', a.unknown ? `${a.unknown} 位状态未明` : ''].filter(Boolean);
      const note = issues.length ? issues.join(' · ') : a.kind === 'idle' ? '窗帘合上，小猫打盹' : a.kind === 'empty' ? '房子还在，等成员回来' : '烟囱冒烟，小旗飘动';
      const source = a.fallback ? `${a.logs} 日志 · ${a.fallback} Herdr 回退` : a.total ? '状态来源：会话日志' : '暂无成员状态';
      const roles = roleSummary(team.id);
      house.dataset.label = `进入 ${name} · ${ACTIVITY_LABELS[a.kind]} · ${a.busy}/${a.total} 正在忙 · ${note} · ${source}${roles ? ` · ${roles}` : ''}`;
      const content = `<span class="house-number"><span>${escape(team.id)} / ${team.id === 'ungrouped' ? 'SESSION HOUSE' : 'TEAM HOUSE'}</span><span class="house-arrow" aria-hidden="true">↗</span></span>
        <span class="house-name">${escape(name)}</span>
        <span class="house-meta"><span class="status-chip" data-status="${a.kind}"><span class="state-symbol" aria-hidden="true">${ACTIVITY_SYMBOLS[a.kind]}</span>${ACTIVITY_LABELS[a.kind]}</span><span class="busy-ratio"><b>${a.busy}/${a.total}</b> 正在忙</span></span>
        <span class="house-divider" aria-hidden="true"></span>
        <span class="house-note">${note}</span>${roles ? `<span class="house-roles">${roles}</span>` : ''}<span class="house-source">${source}</span>
        <span class="house-freshness" hidden>${clock}<span></span></span>`;
      const sign = house.querySelector('.house-sign');
      if (sign._content !== content) { sign.innerHTML = content; sign._content = content; }
      // Preserve nodes (focus/animation) but keep a changed workspace order correct.
      if ($('houses').children[index] !== house) $('houses').insertBefore(house, $('houses').children[index] || null);
    });
    for (const [id, node] of houses) if (!ids.has(id)) {
      contentObserver.unobserve(node.querySelector('.house-art-stage'));
      contentObserver.unobserve(node.querySelector('.house-sign'));
      node.remove(); houses.delete(id);
    }
    $('empty').hidden = data.teams.length > 0;
    $('busy-team-count').textContent = summary.busyTeams;
    $('idle-team-count').textContent = summary.idleTeams;
    $('working-count').textContent = summary.workingAgents;
    $('overview-note').textContent = `${summary.teams} 个团队${summary.otherTeams ? ` · ${summary.otherTeams} 个待处理 / 未明 / 空屋` : ''}${summary.ungroupedAgents ? ` · 另有 ${summary.ungroupedAgents} 位未分组成员` : ''}`;
    scheduleLayout();
  }
  function navigate(id) {
    // A house opens the original page, not a second implementation of Office.
    location.assign(`/office?team=${encodeURIComponent(id)}`);
  }
  function receive(next) {
    if (!next || !Array.isArray(next.sessions)) return;
    loaded = true;
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
    const anyStale = stale || data.teams.some(team => team.presence === 'stale');
    $('connection').dataset.live = !stale;
    $('connection').textContent = !loaded ? '正在读取状态…' : stale ? '连接中 / 状态可能过期' : anyStale ? '实时同步 · 部分身份过期' : '实时同步 · 日志优先';
    $('source-warning').hidden = !loaded || !stale;
    $('source-warning').textContent = data.source?.error || '连接暂不可用，保留最后一次状态；连接恢复后会自动更新。';
    $('summary-freshness').textContent = !loaded ? '正在读取状态…' : stale ? '上次快照 · 可能过期' : anyStale ? '日志优先 · 部分身份过期' : '日志优先 · 实时概览';
    for (const { team, activity } of summary.houses) {
      const house = houses.get(team.id), expired = isStale(team);
      house.dataset.stale = expired;
      const label = `上次状态：${ACTIVITY_LABELS[activity.kind]} · 可能过期${team.presence === 'stale' ? ' · 身份过期' : ''}`;
      const freshness = house.querySelector('.house-freshness');
      freshness.hidden = !expired;
      const text = freshness.querySelector('span');
      if (text.textContent !== label) text.textContent = label;
      house.setAttribute('aria-label', house.dataset.label + (expired ? ` · ${label}` : ''));
    }
    updateMotion();
  }
  $('motion-toggle').addEventListener('click', () => { paused = !paused; updateMotion(); });
  $('townLayout').addEventListener('click', event => {
    const button = event.target.closest('button[data-layout]');
    if (!button) return;
    layout = button.dataset.layout;
    try { localStorage.setItem('agent-office-town-layout', layout); } catch {}
    updateLayout();
  });
  reducedMotion.addEventListener('change', updateMotion);
  singleColumn.addEventListener('change', scheduleLayout);
  window.addEventListener('resize', scheduleLayout);
  updateLayout();
  updateMotion();
  const events = new EventSource('/events');
  events.onopen = () => { connected = true; updateConnection(); };
  events.onmessage = event => { try { connected = true; receive(JSON.parse(event.data)); } catch (error) { console.error('Invalid town snapshot', error.message); } };
  events.onerror = () => { connected = false; updateConnection(); };
  window.addEventListener('pagehide', () => events.close());
  window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
  // Read-only diagnostics for local verification; not an agent control surface.
  window.teamTown = { get snapshot() { return data; }, get summary() { return summary; } };
})();
