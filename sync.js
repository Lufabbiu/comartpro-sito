/**
 * Sync soci da Google Sheet (AppSheet source) → Postgres members.
 * Geocodifica indirizzi via Nominatim (OSM, rate-limit 1.1s).
 */
const https = require('https');
const { parse } = require('csv-parse/sync');

const SHEET_URL = process.env.SOCI_SHEET_URL ||
  'https://docs.google.com/spreadsheets/d/1Gsp5kidHcVxiVSxIq2bMfKc3AbDcJ6Ik5p2UyI1Xuq8/export?format=csv';

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ComArtPro-Sync/1.0' } }, res => {
      if ([301,302,303,307].includes(res.statusCode) && redirects > 0) {
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

function detectMunicipality(address) {
  if (!address) return null;
  const a = address.toLowerCase();
  if (a.includes('montesardo')) return 'Montesardo';
  if (a.includes('alessano')) return 'Alessano';
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

async function runSync(pool, { verbose = false, force = false } = {}) {
  const started = Date.now();
  const csv = await fetchText(SHEET_URL);
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

  let created = 0, updated = 0, geocoded = 0, skipped = 0;

  for (const r of records) {
    const rowId = r['Timestamp'] || r['timestamp'];
    if (!rowId) { skipped++; continue; }

    const businessName = r['Ragione Sociale'];
    if (!businessName) { skipped++; continue; }

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
    const slug = slugify(businessName) + '-' + String(rowId).slice(-4).replace(/\D/g,'').padStart(4,'0');

    // Check if exists and if address changed (avoid re-geocoding unless needed)
    const { rows: existing } = await pool.query(
      'SELECT id, address, lat, lng FROM members WHERE appsheet_row_id = $1', [rowId]);

    let lat = null, lng = null;
    if (existing[0] && existing[0].address === address && existing[0].lat != null && !force) {
      lat = existing[0].lat; lng = existing[0].lng;
    } else if (address) {
      const g = await geocode(address);
      lat = g.lat; lng = g.lng;
      if (lat) geocoded++;
      await sleep(1100); // Nominatim rate-limit
    }

    const sql = `
      INSERT INTO members (appsheet_row_id, slug, business_name, category, profession, address, municipality,
        phone, email, logo, role, approved, public_consent, lat, lng, last_synced_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now())
      ON CONFLICT (appsheet_row_id) DO UPDATE SET
        slug=EXCLUDED.slug,
        business_name=EXCLUDED.business_name,
        category=EXCLUDED.category,
        profession=EXCLUDED.profession,
        address=EXCLUDED.address,
        municipality=EXCLUDED.municipality,
        phone=EXCLUDED.phone,
        email=EXCLUDED.email,
        logo=EXCLUDED.logo,
        role=EXCLUDED.role,
        approved=EXCLUDED.approved,
        public_consent=EXCLUDED.public_consent,
        lat=COALESCE(EXCLUDED.lat, members.lat),
        lng=COALESCE(EXCLUDED.lng, members.lng),
        last_synced_at=now(),
        updated_at=now()`;
    const res = await pool.query(sql, [rowId, slug, businessName, category, profession, address, municipality,
      phone, email, logo, role, approved, publicConsent, lat, lng]);
    if (existing[0]) updated++; else created++;
    if (verbose) console.log(`  ${existing[0]?'↻':'+'} ${businessName}`);
  }

  const ms = Date.now() - started;
  console.log(`✓ Sync soci: ${created} nuovi, ${updated} aggiornati, ${geocoded} geocodificati, ${skipped} saltati (${ms}ms)`);
  return { created, updated, geocoded, skipped, ms };
}

module.exports = { runSync };
