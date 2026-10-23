'use strict';
// Serves the renderer over HTTP with the real handlers behind it, so the UI can be driven in
// a plain browser against a fake install (no Electron needed).
//   node test/ui-harness.js [port]   -> prints the URL and the fixture paths

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandlers } = require('../src/main/handlers');
const { makeInstall } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// In the page: window.porter.call -> POST /call
const SHIM = `window.porter = { call: async (channel, ...args) => {
  const r = await fetch('/call', { method: 'POST', body: JSON.stringify({ channel, args }) }).then((x) => x.json());
  if (!r.ok) throw new Error(r.error);
  return r.value;
} };`;

function start(port = 0, fx = makeInstall()) {
  process.env.FPP_WOW_ROOTS = fx.wowRoot;
  const env = {
    dataDir: fx.dataDir,
    version: require('../package.json').version,
    pickFolder: async () => env.nextFolder || null,
    saveFile: async () => path.join(fx.root, 'export.ffpsnap'),
    openFile: async () => path.join(fx.root, 'export.ffpsnap'),
    openPath: async () => '',
    writeClipboard: (text) => { env.clipboard = text; },
  };
  const handlers = createHandlers(env);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/call') {
      let body = '';
      for await (const c of req) body += c;
      const { channel, args } = JSON.parse(body);
      let out;
      try {
        out = { ok: true, value: await handlers[channel](...args) };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(out ?? null));
    }
    const p = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', TYPES[path.extname(p)] || 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, env, fx, url: `http://127.0.0.1:${server.address().port}/src/renderer/index.html`, shim: SHIM });
  }));
}

if (require.main === module) {
  start(Number(process.argv[2]) || 0).then(({ url, fx }) => console.log(JSON.stringify({ url, ...fx }, null, 2)));
}

module.exports = { start, SHIM };
