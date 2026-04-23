/**
 * OpenAI integration — bozze ricche con approfondimento.
 * Env: OPENAI_API_KEY
 */
const https = require('https');

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MODEL_IMAGE = 'dall-e-3';

function postJson(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let chunks = ''; res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(chunks);
          if (res.statusCode >= 400) return reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
          resolve(parsed);
        } catch (e) { reject(new Error('Invalid JSON: ' + chunks.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function fetchText(url, limit = 150000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, { headers: { 'User-Agent': 'ComArtPro-AI/1.0' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) return resolve(fetchText(res.headers.location, limit));
      let data = '';
      res.on('data', c => { data += c; if (data.length > limit) { res.destroy(); resolve(data.slice(0, limit)); } });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const SCHEMAS = {
  project: {
    fields: `name (string), tag (string, categoria breve), description (string, 1-2 frasi di anteprima), status (string), content (string, MARKDOWN ricco di 600-1200 parole con titoli ## e paragrafi, approfondimento editoriale del progetto), suggestedImagePrompt (string, prompt in inglese per DALL-E)`,
    example: `{"name":"CompraAlessano","tag":"Promozione commercio","description":"Campagna permanente per valorizzare le attività locali di Alessano e Montesardo.","status":"Attivo","content":"## Perché CompraAlessano\\n\\nNegli ultimi anni il commercio di prossimità...\\n\\n## Come funziona\\n\\n...\\n\\n## I numeri\\n\\n...","suggestedImagePrompt":"Warm italian village street in Salento with small shops..."}`
  },
  event: {
    fields: `title (string), date (ISO 8601 datetime), location (string), description (string, 1-2 frasi), content (string, MARKDOWN ricco di 600-1200 parole con titoli ## e paragrafi: contesto, programma, relatori, perché partecipare), organizers (string), sponsors (string), info (string), suggestedImagePrompt (string, inglese)`,
    example: `{"title":"Incontro con Nicola Gratteri","date":"2026-04-17T19:30:00","location":"Palazzo Ducale, Alessano","description":"Il Procuratore presenta il libro Cartelli di Sangue.","content":"## Un appuntamento atteso\\n\\n...\\n\\n## Il libro\\n\\n...\\n\\n## Il relatore\\n\\n...","organizers":"Com.Art.Pro","sponsors":"Martinucci","info":"Ingresso libero","suggestedImagePrompt":"Cultural event poster, Italian palazzo..."}`
  },
  news: {
    fields: `title (string), excerpt (string, 1-2 frasi anteprima), body (string, MARKDOWN ricco di 500-1000 parole con titoli ## se serve), suggestedImagePrompt (string, inglese)`,
    example: `{"title":"Inaugurata la nuova sede","excerpt":"2 righe di anteprima","body":"## Contesto\\n\\nIl testo completo...\\n\\n## Dettagli\\n\\n...","suggestedImagePrompt":"..."}`
  }
};

const SYSTEM_PROMPT = `Sei un editor esperto dell'associazione Com.Art.Pro APS ETS (commercianti, artigiani, liberi professionisti di Alessano e Montesardo, Basso Salento, Puglia).

STILE
- Italiano istituzionale-contemporaneo, mai corporate, mai retorica vuota
- Tono caldo, concreto, diretto, preciso
- Preferire fatti verificabili a slogan
- Quando cita territorio (Alessano, Montesardo, Salento) lo fa in modo naturale, non enfatico
- Frasi di lunghezza variabile, niente ripetizioni forzate

APPROFONDIMENTO (campo "content" o "body")
- DEVE essere un vero testo editoriale di 600-1200 parole in MARKDOWN
- Struttura a sezioni con titoli ## (es. "## Contesto", "## Perché", "## Cosa prevede", "## Chi è coinvolto")
- Usa pienamente le fonti fornite (testo utente, link, immagini): estrai fatti, citazioni, dettagli, dati
- Se il link porta a una pagina ricca (articolo, comunicato stampa, libro): riassumine sostanza e argomenti chiave
- Se c'è un'immagine: estraine informazioni (testo visibile, persone, luogo, data, contesto)
- Mai inventare nomi, date o dettagli: se un'informazione manca, omettila
- Mai riempire con fluff. Meglio 800 parole sostanziose che 1200 di riempitivo

OUTPUT
Rispondi SOLO con un oggetto JSON valido secondo lo schema.
Nessun markdown code fence attorno al JSON. Nessun testo prima o dopo.`;

async function generateDraft({ type, text = '', sourceUrl = '', imageUrls = [], documents = [], extra = '' }, pool) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY non configurata');
  const schema = SCHEMAS[type];
  if (!schema) throw new Error('Tipo non valido: ' + type);

  // Backward compat: imageUrl singolo
  if (typeof imageUrls === 'string') imageUrls = imageUrls ? [imageUrls] : [];

  // Fetch URL content (può essere lungo)
  let fetchedText = '';
  if (sourceUrl) {
    try {
      const html = await fetchText(sourceUrl);
      const plain = htmlToText(html);
      fetchedText = '\n\n=== CONTENUTO FONTE DAL LINK ===\n' + plain.slice(0, 20000) + (plain.length > 20000 ? '\n\n[...testo troncato]' : '');
    } catch (e) {
      fetchedText = '\n\n[Link non leggibile: ' + e.message + ']';
    }
  }

  const docsNote = documents.length
    ? '\n\n=== ALLEGATI (nomi file) ===\n' + documents.map(d => `- ${d}`).join('\n')
    : '';

  const promptText = `Genera una bozza di ${type === 'project' ? 'PROGETTO' : type === 'event' ? 'EVENTO' : 'NOTIZIA'} per l'associazione.

Schema JSON richiesto (campi e tipi): ${schema.fields}
Esempio di forma: ${schema.example}

=== CONTESTO FORNITO DALL'UTENTE ===
${text || '(nessuna descrizione esplicita)'}${extra ? '\n\nNote aggiuntive: ' + extra : ''}${docsNote}${fetchedText}

${imageUrls.length ? `Ci sono ${imageUrls.length} immagine/i allegate: considerane il contenuto visibile (testo, persone, date, luoghi) come fonte primaria.` : ''}

Genera ora il JSON con tutti i campi dello schema. In particolare il campo di approfondimento (content o body) DEVE essere un testo strutturato in markdown di almeno 600 parole se le fonti lo permettono.`;

  const userParts = [{ type: 'text', text: promptText }];

  // Attach images (local /uploads/:id → base64 data URL dal DB; esterne → URL diretto)
  for (const url of imageUrls.slice(0, 4)) {
    let finalUrl = url;
    if (url.startsWith('/uploads/')) {
      if (!pool) continue;
      const id = decodeURIComponent(url.slice('/uploads/'.length));
      const { rows } = await pool.query('SELECT data, mime FROM media WHERE id = $1', [id]);
      if (!rows.length) continue;
      const mime = rows[0].mime || 'image/png';
      const b64 = Buffer.from(rows[0].data).toString('base64');
      finalUrl = `data:${mime};base64,${b64}`;
    } else if (url.startsWith('/')) {
      continue;
    }
    userParts.push({ type: 'image_url', image_url: { url: finalUrl, detail: 'high' } });
  }

  const res = await postJson('https://api.openai.com/v1/chat/completions', {
    model: MODEL_TEXT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.85,
    max_tokens: 4000
  }, API_KEY);

  const content = res.choices?.[0]?.message?.content;
  if (!content) throw new Error('Risposta AI vuota');
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new Error('AI response non è JSON valido: ' + content.slice(0, 200)); }
  return parsed;
}

async function generateImage(prompt, pool) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY non configurata');
  if (!pool) throw new Error('DB pool richiesto per salvare l\'immagine generata');
  const res = await postJson('https://api.openai.com/v1/images/generations', {
    model: MODEL_IMAGE, prompt: prompt.slice(0, 4000), size: '1024x1024', n: 1, quality: 'standard'
  }, API_KEY);
  const url = res.data?.[0]?.url;
  if (!url) throw new Error('Nessuna immagine generata');
  const buf = await new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode !== 200) return reject(new Error(`DALL-E download HTTP ${r.statusCode}`));
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    }).on('error', reject);
  });
  const id = `ai-${Date.now()}.png`;
  await pool.query(
    'INSERT INTO media (id, filename, mime, data, size) VALUES ($1,$2,$3,$4,$5)',
    [id, id, 'image/png', buf, buf.length]
  );
  return { url: `/uploads/${id}`, prompt };
}

module.exports = { generateDraft, generateImage };
