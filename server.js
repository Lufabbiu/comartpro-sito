/**
 * Com.Art.Pro — server con admin, Postgres (Neon) e upload.
 * Env:
 *   DATABASE_URL     Neon postgres connection string
 *   ADMIN_PASSWORD   password amministratore
 *   SESSION_SECRET   stringa random per firmare i cookie
 *   DATA_DIR         opzionale (path per seed db.json legacy, default ./data)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { formidable } = require('formidable');
const { Pool } = require('pg');
const { runSync, geocodePending } = require('./sync');
const { generateDraft, generateImage, generateLedwallCampaign } = require('./ai');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'comartpro2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_DAYS = 7;

if (!process.env.DATABASE_URL) {
  console.error('⚠️  DATABASE_URL non impostata — usa la connection string Neon');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ——— MIGRATIONS + SEED ———
async function migrate() {
  const q = `
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TIMESTAMPTZ,
      location TEXT,
      description TEXT,
      poster TEXT,
      pdf TEXT,
      organizers TEXT,
      sponsors TEXT,
      info TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TIMESTAMPTZ,
      author TEXT,
      excerpt TEXT,
      body TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tag TEXT,
      description TEXT,
      status TEXT,
      color TEXT,
      link TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    ALTER TABLE news ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS teaser TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS content TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS content TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS gallery TEXT DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS gallery TEXT DEFAULT '[]';
    ALTER TABLE news ADD COLUMN IF NOT EXISTS gallery TEXT DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      appsheet_row_id TEXT UNIQUE,
      slug TEXT UNIQUE,
      business_name TEXT,
      category TEXT,
      profession TEXT,
      address TEXT,
      municipality TEXT,
      phone TEXT,
      email TEXT,
      logo TEXT,
      description TEXT,
      role TEXT,
      approved BOOLEAN DEFAULT FALSE,
      public_consent BOOLEAN DEFAULT TRUE,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_members_category ON members(category);
    CREATE INDEX IF NOT EXISTS idx_members_municipality ON members(municipality);
    CREATE INDEX IF NOT EXISTS idx_members_approved ON members(approved, public_consent);
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bilanci (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      year INTEGER,
      pdf_url TEXT,
      published_at TIMESTAMPTZ DEFAULT now(),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  await pool.query(q);

  // Seed da JSON legacy se presente e tabelle vuote
  const legacy = path.join(DATA_DIR, 'db.json');
  if (fs.existsSync(legacy)) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM events');
    if (rows[0].n === 0) {
      try {
        const db = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        for (const e of db.events || []) await upsert('events', e);
        for (const n of db.news || []) await upsert('news', n);
        for (const p of db.projects || []) await upsert('projects', p);
        console.log('✓ Seed JSON legacy importato');
      } catch (err) { console.warn('Seed skip:', err.message); }
    }
  } else {
    // Seed di default: eventi e progetti iniziali
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM events');
    if (rows[0].n === 0) {
      await upsert('events', {
        id: 'gratteri-2026',
        title: 'Nicola Gratteri presenta «Cartelli di Sangue»',
        date: '2026-04-17T19:30:00',
        location: 'Palazzo Ducale Sangiovanni, Piazza Castello 26, Alessano',
        description: 'Il Procuratore Nicola Gratteri presenta il libro «Cartelli di Sangue» (Mondadori), dedicato alle rotte del narcotraffico. Dialoga con Federico Imperato, docente di Storia delle Relazioni Internazionali all\'Università di Bari.',
        poster: '/public/events/gratteri.jpg',
        pdf: '/public/events/gratteri.pdf',
        organizers: 'Associazione Culturale NarrAzioni · Idrusa Libreria · Com.Art.Pro APS ETS',
        sponsors: 'Martinucci · Pedone Veicoli · Demarco Autoscuola · EdilCasa · Agenzia Pedone',
        info: 'Ingresso libero fino a esaurimento posti · Info 349.6415030'
      });
      for (const p of [
        { id: 'compra-alessano', name: 'CompraAlessano', tag: 'Promozione commercio', description: 'Campagna permanente per valorizzare il commercio di prossimità.', status: 'Attivo', color: 'brand' },
        { id: 'fiera-agro', name: 'Fiera Agroartigianale', tag: 'Evento annuale', description: 'Vetrina delle eccellenze agroalimentari e artigianali del territorio.', status: 'Ricorrente', color: 'gold' },
        { id: 'natale-comartpro', name: 'Natale ComArtPro', tag: 'Eventi stagionali', description: 'Calendario di iniziative natalizie che anima il centro di Alessano.', status: 'Ricorrente', color: 'red' },
        { id: 'ledwall', name: 'Led Wall ComArtPro', tag: 'Comunicazione', description: 'Infrastruttura di comunicazione condivisa con portale dedicato ai soci.', status: 'In valutazione', color: 'ink', link: 'https://comartpro-ledwall-production.up.railway.app/' }
      ]) await upsert('projects', p);
      console.log('✓ Seed default creato');
    }
  }
}

// ——— Generic upsert (whitelisted cols) ———
const COLS = {
  events: ['id','title','date','location','description','content','poster','teaser','pdf','organizers','sponsors','info','gallery','sort_order'],
  news: ['id','title','date','author','excerpt','body','image','gallery','sort_order'],
  projects: ['id','name','tag','description','content','status','color','link','image','gallery','sort_order'],
  bilanci: ['id','title','description','year','pdf_url','sort_order']
};
async function upsert(table, row) {
  const cols = COLS[table];
  const vals = cols.map(c => {
    let v = row[c];
    if (c === 'date' && v && typeof v === 'string' && v.length === 16) v = v + ':00';
    if (c === 'gallery' && Array.isArray(v)) v = JSON.stringify(v);
    if (c === 'gallery' && v == null) v = '[]';
    if (c === 'year' && (v === '' || v == null)) v = null;
    else if (c === 'year' && typeof v === 'string') v = parseInt(v, 10) || null;
    if (v === '') v = null;
    return v ?? null;
  });
  const placeholders = cols.map((_,i) => `$${i+1}`).join(',');
  const updates = cols.filter(c => c !== 'id').map(c => `${c}=EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
               ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at=now()`;
  await pool.query(sql, vals);
}

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
  if (sig.length !== expected.length) return null;
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
// Rate limit ledwall demo: max 3 campagne per IP per ora (in-memory)
const ledwallHits = new Map();
function ledwallRateOk(ip) {
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000;
  const MAX = 3;
  const hits = (ledwallHits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX) { ledwallHits.set(ip, hits); return false; }
  hits.push(now);
  ledwallHits.set(ip, hits);
  if (ledwallHits.size > 500) {
    const cutoff = now - WINDOW_MS;
    for (const [k, v] of ledwallHits) if (!v.some(t => t > cutoff)) ledwallHits.delete(k);
  }
  return true;
}

async function serveMedia(res, id) {
  if (!id || id.includes('/')) { res.writeHead(404); return res.end('Not found'); }
  try {
    const { rows } = await pool.query('SELECT data, mime FROM media WHERE id = $1', [id]);
    if (!rows.length) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': rows[0].mime || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(rows[0].data);
  } catch (e) {
    console.error('[serveMedia]', e.message);
    res.writeHead(500); res.end('Server error');
  }
}

// ——— API ———
async function handleApi(req, res, url) {
  const method = req.method;

  // Auth
  if (url.pathname === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const pwd = String(body.password || '');
    const a = Buffer.from(pwd.padEnd(64, '.').slice(0, 64));
    const b = Buffer.from(ADMIN_PASSWORD.padEnd(64, '.').slice(0, 64));
    if (!crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'Password errata' });
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

  // Public reads
  if (url.pathname === '/api/events' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM events ORDER BY sort_order ASC, date DESC NULLS LAST');
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/news' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM news ORDER BY sort_order ASC, date DESC NULLS LAST');
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/projects' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC');
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/bilanci' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM bilanci ORDER BY sort_order ASC, year DESC NULLS LAST, created_at DESC');
    return json(res, 200, rows);
  }

  if (url.pathname === '/api/ai/ledwall-campaign' && method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    if (!ledwallRateOk(ip)) return json(res, 429, { error: 'Troppe richieste. Riprova fra qualche minuto.' });
    try {
      const body = await readJsonBody(req);
      // Lookup member match sul database: prima esatto case-insensitive, poi contains
      let member = null;
      const q = (body.businessName || '').trim();
      if (q) {
        const exact = await pool.query(
          `SELECT business_name, address, municipality, phone, email, profession, category
           FROM members WHERE approved=TRUE AND LOWER(business_name)=LOWER($1) LIMIT 1`, [q]);
        member = exact.rows[0] || null;
        if (!member) {
          const fuzzy = await pool.query(
            `SELECT business_name, address, municipality, phone, email, profession, category
             FROM members WHERE approved=TRUE AND business_name ILIKE $1 LIMIT 1`, ['%' + q + '%']);
          member = fuzzy.rows[0] || null;
        }
      }
      body.memberInfo = member;
      const result = await generateLedwallCampaign(body, pool);
      result.matchedMember = member;
      return json(res, 200, result);
    } catch (e) {
      console.error('[ledwall-campaign error]', e.message, e.stack);
      return json(res, 500, { error: e.message });
    }
  }
  if (url.pathname === '/api/members' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const cat = url.searchParams.get('category');
    const muni = url.searchParams.get('municipality');
    const params = [];
    const where = ['approved = TRUE', 'public_consent = TRUE'];
    if (q) { params.push('%' + q + '%'); where.push(`(business_name ILIKE $${params.length} OR profession ILIKE $${params.length} OR address ILIKE $${params.length})`); }
    if (cat) { params.push(cat); where.push(`category = $${params.length}`); }
    if (muni) { params.push(muni); where.push(`municipality = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT id, slug, business_name, category, profession, address, municipality, phone, email, logo, description, lat, lng
       FROM members WHERE ${where.join(' AND ')} ORDER BY business_name`, params);
    return json(res, 200, rows);
  }

  // Admin-only
  if (!isAdmin(req)) return json(res, 401, { error: 'Non autenticato' });

  if (url.pathname === '/api/sync-members' && method === 'POST') {
    try {
      const result = await runSync(pool);
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/geocode-pending' && method === 'POST') {
    try {
      const result = await geocodePending(pool, 50);
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/ai/status' && method === 'GET') {
    return json(res, 200, {
      configured: !!process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    });
  }
  if (url.pathname === '/api/ai/draft' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await generateDraft(body, pool);
      return json(res, 200, result);
    } catch (e) {
      console.error('[AI draft error]', e.message, e.stack);
      return json(res, 500, { error: e.message });
    }
  }
  if (url.pathname === '/api/ai/image' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt richiesto' });
      const result = await generateImage(body.prompt, pool);
      return json(res, 200, result);
    } catch (e) {
      console.error('[AI image error]', e.message, e.stack);
      return json(res, 500, { error: e.message });
    }
  }

  if (url.pathname === '/api/members-stats' && method === 'GET') {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE approved=TRUE AND public_consent=TRUE)::int AS public,
        COUNT(*) FILTER (WHERE approved=TRUE AND public_consent=TRUE AND lat IS NOT NULL)::int AS geocoded,
        COUNT(*) FILTER (WHERE approved=FALSE)::int AS not_approved
      FROM members`);
    return json(res, 200, rows[0]);
  }
  if (url.pathname === '/api/members-all' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM members ORDER BY business_name');
    return json(res, 200, rows);
  }

  if (url.pathname === '/api/upload' && method === 'POST') {
    const form = formidable({ keepExtensions: true, maxFileSize: 25 * 1024 * 1024 });
    form.parse(req, async (err, fields, files) => {
      if (err) return json(res, 500, { error: err.message });
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return json(res, 400, { error: 'Nessun file' });
      try {
        const ext = path.extname(file.originalFilename || file.filepath || '').toLowerCase() || '.bin';
        const id = crypto.randomUUID() + ext;
        const data = fs.readFileSync(file.filepath);
        const mime = file.mimetype || 'application/octet-stream';
        await pool.query(
          'INSERT INTO media (id, filename, mime, data, size) VALUES ($1,$2,$3,$4,$5)',
          [id, file.originalFilename || id, mime, data, data.length]
        );
        fs.unlink(file.filepath, () => {});
        return json(res, 200, { url: `/uploads/${id}`, name: file.originalFilename });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // Reorder
  const reorderMatch = url.pathname.match(/^\/api\/(events|news|projects|bilanci)\/reorder$/);
  if (reorderMatch && method === 'POST') {
    const coll = reorderMatch[1];
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE ${coll} SET sort_order=$1, updated_at=now() WHERE id=$2`, [i, ids[i]]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    return json(res, 200, { ok: true });
  }

  // CRUD events/news/projects/bilanci
  const match = url.pathname.match(/^\/api\/(events|news|projects|bilanci)(?:\/(.+))?$/);
  if (match) {
    const coll = match[1], id = match[2];
    if (method === 'POST') {
      const body = await readJsonBody(req);
      body.id = body.id || crypto.randomUUID();
      await upsert(coll, body);
      const { rows } = await pool.query(`SELECT * FROM ${coll} WHERE id=$1`, [body.id]);
      return json(res, 200, rows[0]);
    }
    if (method === 'PUT' && id) {
      const body = await readJsonBody(req);
      body.id = id;
      await upsert(coll, body);
      const { rows } = await pool.query(`SELECT * FROM ${coll} WHERE id=$1`, [id]);
      return json(res, 200, rows[0]);
    }
    if (method === 'DELETE' && id) {
      await pool.query(`DELETE FROM ${coll} WHERE id=$1`, [id]);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'Route non trovata' });
}

// ——— Server boot ———
async function main() {
  try { await migrate(); }
  catch (err) { console.error('Migration error:', err.message); }

  // Sync + geocoding
  if (process.env.DATABASE_URL) {
    setTimeout(() => runSync(pool).catch(e => console.error('Sync error:', e.message)), 5_000);
    setInterval(() => runSync(pool).catch(e => console.error('Sync error:', e.message)), 30 * 60 * 1000);
    // Geocoding continuo: ogni 3 min prova a geocodificare 50 pending
    setInterval(() => geocodePending(pool, 50).catch(e => console.error('Geocode error:', e.message)), 3 * 60 * 1000);
  }

  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      if (p.startsWith('/api/')) return handleApi(req, res, url);
      if (p.startsWith('/uploads/')) return serveMedia(res, decodeURIComponent(p.slice('/uploads/'.length)));
      if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(ROOT, 'admin.html'));
      let urlPath = decodeURIComponent(p);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
      return serveFile(res, filePath);
    } catch (e) {
      console.error(e);
      res.writeHead(500); res.end('Server error');
    }
  }).listen(PORT, '0.0.0.0', () => console.log(`comartpro.it listening on 0.0.0.0:${PORT}`));
}
main();
