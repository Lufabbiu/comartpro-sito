/**
 * Sync soci da Google Sheet → Postgres.
 * 2 fasi: (1) import dati veloce, (2) geocoding in background.
 */
const https = require('https');
const { parse } = require('csv-parse/sync');

const SHEET_URL = process.env.SOCI_SHEET_URL ||
  'https://docs.google.com/spreadsheets/d/1Gsp5kidHcVxiVSxIq2bMfKc3AbDcJ6Ik5p2UyI1Xuq8/export?format=csv';

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ComArtPro-Sync/1.0 (info@comartpro.it)' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && redirects > 0) {
        return resolve(fetchText(res.headers.location, redirects - 1));
      }
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
function detectMunicipality(a) {
  if (!a) return null;
  const s = a.toLowerCase();
  if (s.includes('montesardo')) return 'Montesardo';
  if (s.includes('alessano')) return 'Alessano';
  return null;
}
function boolish(v) {
  const s = String(v || '').toLowerCase().trim();
  return s === 'true' || s === 'si' || s === 'sì' || s === '1' || s === 'x';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocode(address) {
  if (!address) return { lat: null, lng: null };
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  try {
    const body = await fetchText(url);
    const arr = JSON.parse(body);
    if (arr && arr[0]) return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
  } catch {}
  return { lat: null, lng: null };
}

/** Pass 1: import/upsert all rows, no geocoding. Veloce (~1-2s). */
async function importMembers(pool) {
  const started = Date.now();
  const csv = await fetchText(SHEET_URL);
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

  let created = 0, updated = 0, skipped = 0, errors = 0;

  for (const r of records) {
    try {
      const rowId = r['Timestamp'];
      const businessName = r['Ragione Sociale'];
      if (!rowId || !businessName) { skipped++; continue; }

      const address = r['Indirizzo sede'] || '';
      const municipality = detectMunicipality(address);
      const category = (r['CATEGORIA'] || '').trim() || null;
      const profession = (r['PROFESSIONE'] || '').trim() || null;
      const phone = (r['Numero di telefono'] || '').trim() || null;
      const email = (r['Email Address'] || '').trim() || null;
      const logo = (r['LOGO'] || '').trim() || null;
      const role = (r['SOCIO'] || '').trim() || null;
      const approved = boolish(r['APPROVATO']);
      const publicConsent = r['PUBBLICO'] !== undefined ? boolish(r['PUBBLICO']) : true;
      const slug = slugify(businessName) + '-' + String(rowId).replace(/\D/g,'').slice(-6).padStart(6,'0');

      const { rows: existing } = await pool.query(
        'SELECT id, address FROM members WHERE appsheet_row_id = $1', [rowId]);
      const addrChanged = existing[0] && existing[0].address !== address;

      // Se esisteva e indirizzo non cambia → mantieni lat/lng. Se nuovo o address cambia → metti null (verrà geocodificato dopo)
      const lat = (existing[0] && !addrChanged) ? undefined : null;
      const lng = (existing[0] && !addrChanged) ? undefined : null;

      const sql = lat === undefined ? `
        INSERT INTO members (appsheet_row_id, slug, business_name, category, profession, address, municipality,
          phone, email, logo, role, approved, public_consent, last_synced_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
        ON CONFLICT (appsheet_row_id) DO UPDATE SET
          slug=EXCLUDED.slug, business_name=EXCLUDED.business_name, category=EXCLUDED.category,
          profession=EXCLUDED.profession, address=EXCLUDED.address, municipality=EXCLUDED.municipality,
          phone=EXCLUDED.phone, email=EXCLUDED.email, logo=EXCLUDED.logo, role=EXCLUDED.role,
          approved=EXCLUDED.approved, public_consent=EXCLUDED.public_consent,
          last_synced_at=now(), updated_at=now()` : `
        INSERT INTO members (appsheet_row_id, slug, business_name, category, profession, address, municipality,
          phone, email, logo, role, approved, public_consent, lat, lng, last_synced_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now())
        ON CONFLICT (appsheet_row_id) DO UPDATE SET
          slug=EXCLUDED.slug, business_name=EXCLUDED.business_name, category=EXCLUDED.category,
          profession=EXCLUDED.profession, address=EXCLUDED.address, municipality=EXCLUDED.municipality,
          phone=EXCLUDED.phone, email=EXCLUDED.email, logo=EXCLUDED.logo, role=EXCLUDED.role,
          approved=EXCLUDED.approved, public_consent=EXCLUDED.public_consent,
          lat=EXCLUDED.lat, lng=EXCLUDED.lng, last_synced_at=now(), updated_at=now()`;
      const params = lat === undefined
        ? [rowId, slug, businessName, category, profession, address, municipality, phone, email, logo, role, approved, publicConsent]
        : [rowId, slug, businessName, category, profession, address, municipality, phone, email, logo, role, approved, publicConsent, lat, lng];
      await pool.query(sql, params);
      if (existing[0]) updated++; else created++;
    } catch (e) {
      errors++;
      console.warn('  ✗ errore riga', r['Ragione Sociale'], ':', e.message);
    }
  }

  const ms = Date.now() - started;
  console.log(`✓ Import soci: ${created} nuovi, ${updated} aggiornati, ${skipped} vuoti, ${errors} errori (${ms}ms)`);
  return { created, updated, skipped, errors, ms };
}

/** Pass 2: geocoding in background dei membri senza coordinate. */
async function geocodePending(pool, maxRequests = 50) {
  const { rows } = await pool.query(
    `SELECT id, address FROM members
     WHERE approved=TRUE AND public_consent=TRUE
       AND address IS NOT NULL AND address <> '' AND lat IS NULL
     LIMIT $1`, [maxRequests]);

  if (!rows.length) return { geocoded: 0, remaining: 0 };

  let ok = 0;
  for (const m of rows) {
    const g = await geocode(m.address);
    if (g.lat) {
      await pool.query('UPDATE members SET lat=$1, lng=$2, updated_at=now() WHERE id=$3', [g.lat, g.lng, m.id]);
      ok++;
    }
    await sleep(1100);
  }
  const { rows: rest } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM members
     WHERE approved=TRUE AND public_consent=TRUE AND address <> '' AND lat IS NULL`);
  console.log(`✓ Geocoded ${ok}/${rows.length}, remaining: ${rest[0].n}`);
  return { geocoded: ok, remaining: rest[0].n };
}

/** Entry point: import sempre, poi geocoding in background. */
async function runSync(pool, opts = {}) {
  const result = await importMembers(pool);
  if (!opts.skipGeocode) {
    // Fire and forget
    geocodePending(pool, 50).catch(e => console.error('Geocoding error:', e.message));
  }
  return result;
}

module.exports = { runSync, importMembers, geocodePending };
