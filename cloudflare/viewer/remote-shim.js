// Remote mode for the Cloudflare viewer. Loaded before the page scripts, it
// replaces the local `/events` EventSource with a read-only WebSocket feed
// from the TownState Durable Object. Shows "mini-1 离线" when the last push
// from mini-1 is older than 60s (mini-1 pushes on change + every 20s).
(() => {
  'use strict';
  const OFFLINE_MS = 60_000;
  function isOffline(clock, localNow) {
    if (!clock || !clock.lastPushAt || !clock.serverNow || !clock.receivedAt) return true;
    return clock.serverNow - clock.lastPushAt + (localNow - clock.receivedAt) > OFFLINE_MS;
  }
  function withPresence(snapshot, offline) {
    if (!snapshot || !offline) return snapshot;
    return { ...snapshot, source: { ...(snapshot.source || {}), presence: 'stale', error: 'mini-1 离线：超过 60 秒没有收到更新，显示的是上次快照。' } };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { isOffline, withPresence, OFFLINE_MS }; return; }

  const NativeEventSource = window.EventSource;
  const feeds = new Set();
  let socket = null, snapshot = null, clock = null, offline = true, failures = 0, retry = 0;

  function banner() {
    let el = document.getElementById('remote-offline');
    if (!el && document.body) {
      el = document.createElement('div');
      el.id = 'remote-offline';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:99999;padding:6px 14px;border-radius:999px;background:#7a2e1f;color:#fff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    if (!el) return;
    const text = failures >= 6 ? '连接不上，可能需要重新登录：请刷新页面' : offline ? (snapshot ? 'mini-1 离线（超过 60 秒没有更新）' : '等待 mini-1 推送…') : '';
    el.hidden = !text;
    el.textContent = text;
  }
  function emit(type, data) {
    for (const feed of feeds) feed._emit(type, data);
  }
  function deliver() {
    if (snapshot) emit('message', JSON.stringify(withPresence(snapshot, offline)));
    banner();
  }
  function check() {
    const now = isOffline(clock, Date.now());
    if (now !== offline) {
      offline = now;
      if (offline) emit('error'); else emit('open');
      deliver();
    }
  }
  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => { failures = 0; retry = 0; };
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      clock = { lastPushAt: msg.lastPushAt, serverNow: msg.serverNow, receivedAt: Date.now() };
      if (msg.snapshot) snapshot = msg.snapshot;
      const was = offline;
      offline = isOffline(clock, Date.now());
      if (was && !offline) emit('open');
      if (msg.snapshot || was !== offline) deliver(); else banner();
    };
    socket.onclose = () => {
      socket = null;
      failures++;
      emit('error');
      banner();
      retry = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(failures, 4)));
    };
  }
  class RemoteEvents {
    constructor(url) {
      if (!String(url).endsWith('/events')) return new NativeEventSource(url);
      this.url = String(url); this.readyState = 0;
      this.onopen = this.onmessage = this.onerror = null;
      this._listeners = { open: new Set(), message: new Set(), error: new Set() };
      feeds.add(this);
      if (!socket && !retry) connect();
      setTimeout(() => {
        if (!feeds.has(this)) return;
        if (!offline) this._emit('open');
        if (snapshot) this._emit('message', JSON.stringify(withPresence(snapshot, offline)));
      }, 0);
    }
    _emit(type, data) {
      if (type === 'open') this.readyState = 1;
      const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
      try { this['on' + type]?.(event); } catch (e) { console.error(e); }
      for (const fn of this._listeners[type] || []) { try { fn(event); } catch (e) { console.error(e); } }
    }
    addEventListener(type, fn) { this._listeners[type]?.add(fn); }
    removeEventListener(type, fn) { this._listeners[type]?.delete(fn); }
    close() { this.readyState = 2; feeds.delete(this); }
  }
  window.EventSource = RemoteEvents;
  setInterval(check, 5000);
  document.addEventListener('DOMContentLoaded', () => {
    // Local-only wording does not apply to the remote copy.
    for (const el of document.querySelectorAll('.brand small')) el.textContent = '团队小镇 / REMOTE · 只读';
    const footer = document.querySelector('.site-footer span:last-child');
    if (footer) footer.textContent = 'CLOUDFLARE ACCESS · READ ONLY · NO PROMPTS';
    banner();
  });
})();
