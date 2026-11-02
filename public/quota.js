(() => {
  'use strict';
  const STALE_MS = 3 * 60 * 60_000;
  const count = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  const time = value => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  function quotaView(account, clock, now = Date.now()) {
    const serverNow = clock.serverNow + Math.max(0, now - clock.receivedAt);
    const age = account.updatedAt ? serverNow - account.updatedAt : Infinity;
    const stale = account.status !== 'ok' || age > STALE_MS || clock.failed;
    const p = account.premium;
    const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const percent = finite(p?.remainingPercent) && p.remainingPercent <= 100 ? p.remainingPercent : null;
    const remaining = p?.unlimited ? '不限额' : percent !== null ? `${percent.toFixed(1)}%` : '—';
    const usage = !p ? '—' : p.unlimited ? '未提供统计' : finite(p.used) && finite(p.limit) && p.limit > 0 ? `${count(p.used)} / ${count(p.limit)}` : '未提供统计';
    const reset = /^\d{4}-\d{2}-\d{2}$/.test(account.resetDate || '') ? `${Number(account.resetDate.slice(5, 7))}/${Number(account.resetDate.slice(8))}` : '—';
    const note = account.status === 'auth-required' ? '需要重新登录' : account.error === 'identity' ? '身份核对失败' : account.status === 'error' ? '更新失败' : !account.updatedAt ? '等待采集' : clock.failed ? '连接中断' : age > STALE_MS ? '已过期' : '';
    return { remaining, usage, reset, note, stale, percent: p?.unlimited ? null : percent };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { quotaView }; return; }
  const root = document.getElementById('quota-panel');
  if (!root) return;
  const rows = document.getElementById('quota-rows');
  const state = document.getElementById('quota-state');
  const table = document.getElementById('quota-table');
  const hint = document.getElementById('quota-hint');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let latest = null, clock = null, pending = false;
  function render() {
    if (!latest?.accounts?.length) {
      table.hidden = true;
      hint.textContent = clock?.failed ? '额度暂时无法读取，请刷新页面重试。' : '尚未启用 Copilot 额度监控。';
      const label = clock?.failed ? '读取失败' : '未启用';
      if (state.textContent !== label) state.textContent = label;
      return;
    }
    table.hidden = false;
    let failed = 0;
    rows.innerHTML = latest.accounts.map(account => {
      const view = quotaView(account, clock);
      if (view.stale) failed++;
      return `<tr data-account="${escape(account.id)}" data-stale="${view.stale}">
        <th scope="row"><span class="quota-login">${escape(account.login)}</span><span class="quota-host">${escape(account.host)}</span><span class="quota-mobile-reset">${escape(view.reset)} 重置</span></th>
        <td class="quota-usage">${escape(view.usage).replace(' / ', '<span class="quota-total"> / ')}${view.usage.includes(' / ') ? '</span>' : ''}</td>
        <td class="quota-remaining"><strong>${escape(view.remaining)}</strong>${view.percent !== null ? `<meter min="0" max="100" value="${view.percent}" aria-label="${escape(account.login)} 剩余额度">${view.percent}%</meter>` : ''}${view.note ? `<span class="quota-note">${escape(view.note)}${account.updatedAt ? ` · ${time(account.updatedAt)}` : ''}</span>` : ''}</td>
        <td class="quota-reset">${escape(view.reset)}</td>
      </tr>`;
    }).join('');
    const updated = latest.capturedAt ? time(latest.capturedAt) : null;
    const label = failed === latest.accounts.length ? '额度尚未更新' : failed ? '部分额度尚未更新' : updated ? `最近采集 ${updated}` : '等待首次采集';
    if (state.textContent !== label) state.textContent = label;
    const unlimited = latest.accounts.every(a => a.chatUnlimited && a.completionsUnlimited);
    hint.textContent = `${unlimited ? '普通聊天与代码补全均不限额。' : ''}用量按 GitHub 计量单位展示。`;
  }
  async function refresh() {
    if (pending) return;
    pending = true;
    try {
      const response = await fetch('/api/quota', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json();
      if (!Number.isFinite(body.serverNow) || (body.quota !== null && !Array.isArray(body.quota?.accounts))) throw new Error('invalid');
      latest = body.quota;
      clock = { serverNow: body.serverNow, receivedAt: Date.now(), failed: false };
    } catch {
      clock = { ...(clock || { serverNow: Date.now(), receivedAt: Date.now() }), failed: true };
    } finally { pending = false; render(); }
  }
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); else if (latest) render(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
})();
