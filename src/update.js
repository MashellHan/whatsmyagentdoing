'use strict';

// Local-only build: version display without networking or git subprocesses.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function checkLatest() {
  return null; // Local-only build: disabled even without an environment override.
}

function canUpdate() {
  return false;
}

function info() {
  const version = localVersion();
  return {
    version,
    latest: null,
    updateAvailable: false,
    canUpdate: canUpdate(),
  };
}

function update() {
  return Promise.reject(new Error('Updates are disabled in this local-only build.'));
}

module.exports = { localVersion, checkLatest, info, update, newer, ROOT };
