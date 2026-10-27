// Copies ONLY the allowlisted UI files into cloudflare/dist for the viewer.
// Never copies docs, config, AGENTS.md / TEAMS.md or anything else.
import { cpSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'cloudflare', 'dist');
const PUBLIC = ['town.html', 'index.html', 'town.js', 'town.css', 'team-office.css', 'office.js', 'office3d.js', 'i18n.js', 'popout.js'];
const ASSET_TYPES = new Set(['.png', '.glb', '.json']);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of PUBLIC) copyFileSync(join(root, 'public', f), join(out, f));
copyFileSync(join(root, 'cloudflare', 'viewer', 'remote-shim.js'), join(out, 'remote-shim.js'));
(function walk(rel) {
  for (const name of readdirSync(join(root, 'assets', rel))) {
    const r = join(rel, name), src = join(root, 'assets', r);
    if (statSync(src).isDirectory()) walk(r);
    else if (ASSET_TYPES.has(extname(name))) { mkdirSync(join(out, 'assets', rel), { recursive: true }); cpSync(src, join(out, 'assets', r)); }
  }
})('');
console.log('built', out);
