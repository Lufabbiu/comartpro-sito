/**
 * Com.Art.Pro — server con admin, storage JSON e upload.
 * Env richieste in prod:
 *   ADMIN_PASSWORD   password amministratore
 *   SESSION_SECRET   stringa random lunga (firma cookie)
 *   DATA_DIR         opzionale, default ./data (in Railway montare un Volume)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const formidable = require('formidable');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'comartpro2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_DAYS = 7;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    events: [{
      id: 'gratteri-2026',
      title: 'Nicola Gratteri presenta «Cartelli di Sangue»',
      date: '2026-04-17T19:30:00',
      location: 'Palazzo Ducale Sangiovanni, Piazza Castello 26, Alessano',
      description: 'Il Procuratore Nicola Gratteri presenta il libro «Cartelli di Sangue» (Mondadori), dedicato alle rotte del narcotraffico. Dialoga con Federico Imperato, docente di Storia delle Relazioni Internazionali all\'Università di Bari.',
      poster: '/public/events/gratteri.jpg',
      pdf: '/public/events/gratteri.pdf',
      organizers: 'Associazione Culturale NarrAzioni · Idrusa Libreria · Com.Art.Pro APS ETS',
      sponsors: 'Martinucci · Pedone Veicoli · Demarco Autoscuola · EdilCasa · Agenzia Pedone',
      info: 'Ingresso libero fino a esaurimento posti · Info 349.6415030',
      createdAt: new Date().toISOString()
    }],
    news: [],
    projects: [
      { id: 'compra-alessano', name: 'CompraAlessano', tag: 'Promozione commercio', description: 'Campagna permanente per valorizzare il commercio di prossimità.', status: 'Attivo', color: 'brand' },
      { id: 'fiera-agro', name: 'Fiera Agroartigianale', tag: 'Evento annuale', description: 'Vetrina delle eccellenze agroalimentari e artigianali del territorio.', status: 'Ricorrente', color: 'gold' },
      { id: 'natale-comartpro', name: 'Natale ComArtPro', tag: 'Eventi stagionali', description: 'Calendario di iniziative natalizie che anima il centro di Alessano.', status: 'Ricorrente', color: 'red' },
      { id: 'ledwall', name: 'Led Wall ComArtPro', tag: 'Comunicazione', description: 'Infrastruttura di comunicazione condivisa con portale dedicato ai soci.', status: 'In valutazione', color: 'ink', link: 'https://comartpro-ledwall-production.up.railway.app/' }
    ]
  }, null, 2));
}

// ——— DB ———
function loadDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ——— Session (HMAC cookie) ———
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function parseCookie(req) {
  const c = req.headers.cookie || '';
  const out = {};
  c.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function isAdmin(req) { return !!verify(parseCookie(req).session); }

// ——— Helpers ———
const MIME = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.json':'application/json; charset=utf-8',
  '.pdf':'application/pdf','.webp':'image/webp','.gif':'image/gif'
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
}

// ——— Handlers ———
async function handleApi(req, res, url) {
  const segs = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // LOGIN
  if (url.pathname === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const pwd = String(body.password || '');
    if (!crypto.timingSafeEqual(Buffer.from(pwd.padEnd(64, '.').slice(0, 64)), Buffer.from(ADMIN_PASSWORD.padEnd(64, '.').slice(0, 64)))) {
      return json(res, 401, { error: 'Password errata' });
    }
    const token = sign({ sub: 'admin', exp: Date.now() + SESSION_DAYS * 864e5 });
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_DAYS*86400}${process.env.NODE_ENV==='production'?'; Secure':''}`);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/me' && method === 'GET') {
    return json(res, 200, { admin: isAdmin(req) });
  }

  // PUBLIC READ
  if (url.pathname === '/api/events' && method === 'GET') return json(res, 200, loadDb().events);
  if (url.pathname === '/api/news' && method === 'GET') return json(res, 200, loadDb().news);
  if (url.pathname === '/api/projects' && method === 'GET') return json(res, 200, loadDb().projects);

  // ADMIN PROTECTED
  if (!isAdmin(req)) return json(res, 401, { error: 'Non autenticato' });

  // UPLOAD
  if (url.pathname === '/api/upload' && method === 'POST') {
    const form = formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 25 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) return json(res, 500, { error: err.message });
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return json(res, 400, { error: 'Nessun file' });
      const base = path.basename(file.filepath);
      return json(res, 200, { url: `/uploads/${base}`, name: file.originalFilename });
    });
    return;
  }

  // CRUD collections: events, news, projects
  const match = url.pathname.match(/^\/api\/(events|news|projects)(?:\/(.+))?$/);
  if (match) {
    const coll = match[1], id = match[2];
    const db = loadDb();
    const items = db[coll];

    if (method === 'GET') return json(res, 200, items);
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const item = { ...body, id: body.id || crypto.randomUUID(), createdAt: new Date().toISOString() };
      items.push(item); saveDb(db);
      return json(res, 200, item);
    }
    if (method === 'PUT' && id) {
      const body = await readJsonBody(req);
      const idx = items.findIndex(x => x.id === id);
      if (idx < 0) return json(res, 404, { error: 'Non trovato' });
      items[idx] = { ...items[idx], ...body, id, updatedAt: new Date().toISOString() };
      saveDb(db);
      return json(res, 200, items[idx]);
    }
    if (method === 'DELETE' && id) {
      const idx = items.findIndex(x => x.id === id);
      if (idx < 0) return json(res, 404, { error: 'Non trovato' });
      items.splice(idx, 1); saveDb(db);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'Route non trovata' });
}

// ——— Server ———
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) return handleApi(req, res, url);

    // Uploads served from DATA_DIR/uploads
    if (p.startsWith('/uploads/')) {
      const safe = path.join(UPLOADS_DIR, path.basename(p));
      return serveFile(res, safe);
    }

    // Admin page
    if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(ROOT, 'admin.html'));

    // Static
    let urlPath = decodeURIComponent(p);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, filePath);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('Server error');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`comartpro.it listening on 0.0.0.0:${PORT} · data: ${DATA_DIR}`));
