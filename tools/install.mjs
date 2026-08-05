#!/usr/bin/env node
/**
 * Load (or hot-reload) Peek into a running Chromium browser over CDP.
 *
 * Aside runs with remote debugging on :9222, so this skips the
 * extensions-page dance entirely. Run it again after an edit to reload;
 * content scripts re-inject on the next page load.
 *
 *   node tools/install.mjs [--port 9222] [--profile "<user data dir>"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = arg('port', '9222');
const profile = arg(
  'profile',
  path.join(process.env.HOME, 'Library/Application Support/Aside')
);

const portFile = path.join(profile, 'DevToolsActivePort');
if (!fs.existsSync(portFile)) {
  console.error(
    `No DevToolsActivePort in ${profile}\n` +
      `Is the browser running with remote debugging enabled?\n` +
      `Fall back to loading it by hand: Extensions → Developer mode → Load unpacked → ${EXT_DIR}`
  );
  process.exit(1);
}

const wsPath = fs.readFileSync(portFile, 'utf8').trim().split('\n')[1];
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);

let id = 0;
const pending = new Map();
const call = (method, params = {}) => {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => {
    pending.set(msg.id, { res, rej });
    setTimeout(() => {
      if (pending.has(msg.id)) {
        pending.delete(msg.id);
        rej(new Error('timed out: ' + method));
      }
    }, 15000);
  });
};

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const { res, rej } = pending.get(m.id);
  pending.delete(m.id);
  m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
};

ws.onerror = () => {
  console.error(`Couldn't reach the browser on :${port}.`);
  process.exit(1);
};

ws.onopen = async () => {
  try {
    const { product } = await call('Browser.getVersion');
    const { id: extId } = await call('Extensions.loadUnpacked', { path: EXT_DIR });
    console.log(`${product}\nPeek loaded: ${extId}`);
    console.log('Reload any open tab to pick up the content scripts.');
  } catch (err) {
    console.error('Load failed:', err.message);
    console.error(
      `Load it by hand instead: Extensions → Developer mode → Load unpacked → ${EXT_DIR}`
    );
    process.exitCode = 1;
  }
  ws.close();
  process.exit(process.exitCode || 0);
};
