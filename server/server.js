'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { seedIfEmpty, backupTo, startBackupSchedule } = require('./db');
const { dispatch, HttpError, userForToken } = require('./api');
const { todayKey } = require('../public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
// Local only by default. Set HOST=0.0.0.0 (behind HTTPS) to let other devices connect.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, data, headers = {}) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const tokenOf = req => /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1] || null;

// A full copy of the database (HQ only; it contains every outlet's data and password hashes).
function sendBackup(req, res) {
  const user = userForToken(tokenOf(req));
  if (!user) throw new HttpError(401, 'Please sign in');
  if (user.role !== 'admin') throw new HttpError(403, 'Only HQ administrators can download backups');
  const file = path.join(os.tmpdir(), `vv-backup-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    backupTo(file);
    send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="velour-backup-${todayKey()}.db"`, 'Cache-Control': 'no-store' });
  } finally { fs.rmSync(file, { force: true }); }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/backup') return sendBackup(req, res);
  let body = {};
  if (req.method !== 'GET') {
    // JSON-only bodies can't be sent cross-site without a CORS preflight, which we never grant.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
    const raw = await readBody(req);
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (body === null || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON');
  }
  const token = tokenOf(req);
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  let cookie = null;
  const setCookie = value => {
    const flags = `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
    cookie = value ? `sid=${value}; Max-Age=${12 * 3600}; ${flags}` : `sid=; Max-Age=0; ${flags}`;
  };
  const result = dispatch({
    method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body, token,
    outletHeader: req.headers['x-outlet-id'], ip: req.socket.remoteAddress || 'unknown', setCookie
  });
  sendJson(res, 200, result, cookie ? { 'Set-Cookie': cookie } : {});
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, 'Not found');
    send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    console.error(error);
    sendJson(res, 500, { error: 'Something went wrong on the server' });
  }
});

const firstPassword = seedIfEmpty();
startBackupSchedule();
server.listen(PORT, HOST, () => {
  console.log(`Scentz running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (firstPassword) {
    console.log('\nFirst run: HQ administrator account created');
    console.log('  username: admin');
    console.log(`  password: ${firstPassword}`);
    console.log('  Sign in and change this password under Store settings.\n');
  }
});
