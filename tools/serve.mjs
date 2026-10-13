#!/usr/bin/env node
// Zero-dependency static server for game/.
//   node tools/serve.mjs [--port 8080]
// Binds localhost only, sends Cache-Control: no-store so edits show up on reload.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'game');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--port');
const PORT = pi >= 0 ? Number(argv[pi + 1]) : Number(process.env.PORT) || 8080;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('✖ bad --port');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
};

function send(res, code, body, head = false) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

const server = http.createServer((req, res) => {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) return send(res, 405, 'Method Not Allowed', head);
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request', head);
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad Request', head);
  let file = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden', head);
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!rel.endsWith('/')) {
        res.writeHead(301, { Location: rel + '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      file = path.join(file, 'index.html');
      try { st = fs.statSync(file); } catch (e) { err = e; }
    }
    if (err || !st.isFile()) return send(res, 404, 'Not Found', head);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (head) return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`✖ port ${PORT} is already in use — pick another with --port N`);
  else console.error('✖', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} at http://localhost:${PORT}/`));
