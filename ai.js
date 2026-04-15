/**
 * OpenAI integration per generazione bozze contenuti.
 * Env: OPENAI_API_KEY
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MODEL_IMAGE = 'dall-e-3';

function postJson(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
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

function fetchText(url, limit = 80000) {
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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

const SCHEMAS = {
  project: {
    fields: 'name, tag, description, status, suggestedImagePrompt',
    example: `{"name":"CompraAlessano","tag":"Promozione commercio","description":"Campagna permanente per...","status":"Attivo","suggestedImagePrompt":"Strada di paese del Salento con botteghe..."}`
  },
  event: {
    fields: 'title, date, location, description, organizers, sponsors, info, suggestedImagePrompt',
    example: `{"title":"Incontro con...","date":"2026-05-10T19:00:00","location":"Palazzo Ducale, Alessano","description":"Una serata...","organizers":"Com.Art.Pro","sponsors":"","info":"Ingresso libero","suggestedImagePrompt":"Sala conferenze con pubblico..."}`
  },
  news: {
    fields: 'title, excerpt, body, suggestedImagePrompt',
    example: `{"title":"Inaugurata la nuova...","excerpt":"2 righe di anteprima","body":"Testo completo dell'articolo...","suggestedImagePrompt":"Foto di inaugurazione con taglio del nastro..."}`
  }
};

const SYSTEM_PROMPT = `Sei un assistente editoriale per Com.Art.Pro APS ETS, associazione di commercianti, artigiani e liberi professionisti di Alessano e Montesardo (Basso Salento, Puglia).
Stile: italiano istituzionale ma contemporaneo. Tono caldo, concreto, chiaro, mai retorico o da corporate. Frasi dirette, niente slogan vuoti.
Valorizza il territorio (Alessano, Montesardo, Salento) solo se coerente con il contenuto.
Rispondi SOLO con un oggetto JSON valido secondo lo schema, senza markdown né testo fuori dal JSON.`;

async function generateDraft({ type, text = '', sourceUrl = '', imageUrl = '', extra = '' }) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY non configurata');
  const schema = SCHEMAS[type];
  if (!schema) throw new Error('Tipo non valido: ' + type);

  // Arricchisci con fonti esterne
  let fetchedText = '';
  if (sourceUrl) {
    try {
      const html = await fetchText(sourceUrl);
      fetchedText = '\n\n--- Contenuto dal link fornito ---\n' + htmlToText(html);
    } catch (e) {
      fetchedText = '\n\n[Impossibile leggere il link: ' + e.message + ']';
    }
  }

  const userParts = [
    { type: 'text', text: `Genera una bozza di ${type === 'project' ? 'PROGETTO' : type === 'event' ? 'EVENTO' : 'NOTIZIA'} per l'associazione.
Campi richiesti nel JSON: ${schema.fields}.
Esempio di formato: ${schema.example}

Contesto fornito dall'utente:
${text || '(nessuna descrizione)'}${extra ? '\n\nNote: ' + extra : ''}${fetchedText}` }
  ];

  if (imageUrl) {
    // Risolvi a URL assoluto/base64
    let finalUrl = imageUrl;
    if (imageUrl.startsWith('/')) {
      // è un upload locale — leggi il file e converti in base64
      const uploadsDir = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, 'data', 'uploads');
      const fname = path.basename(imageUrl);
      const fpath = path.join(uploadsDir, fname);
      if (fs.existsSync(fpath)) {
        const b64 = fs.readFileSync(fpath).toString('base64');
        const ext = path.extname(fname).slice(1).toLowerCase();
        finalUrl = `data:image/${ext==='jpg'?'jpeg':ext};base64,${b64}`;
      }
    }
    userParts.push({ type: 'image_url', image_url: { url: finalUrl } });
    userParts[0].text += '\n\n(Considera anche l\'immagine allegata come fonte.)';
  }

  const res = await postJson('https://api.openai.com/v1/chat/completions', {
    model: MODEL_TEXT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_tokens: 1500
  }, API_KEY);

  const content = res.choices?.[0]?.message?.content;
  if (!content) throw new Error('Risposta AI vuota');
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new Error('AI response non è JSON valido: ' + content.slice(0, 200)); }
  return parsed;
}

async function generateImage(prompt) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY non configurata');
  const res = await postJson('https://api.openai.com/v1/images/generations', {
    model: MODEL_IMAGE,
    prompt: prompt.slice(0, 4000),
    size: '1024x1024',
    n: 1,
    quality: 'standard'
  }, API_KEY);
  const url = res.data?.[0]?.url;
  if (!url) throw new Error('Nessuna immagine generata');

  // Scarica e salva localmente per persistenza (URL OpenAI scadono in 1h)
  const uploadsDir = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, 'data', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const fname = `ai-${Date.now()}.png`;
  const fpath = path.join(uploadsDir, fname);
  await new Promise((resolve, reject) => {
    https.get(url, r => {
      const ws = fs.createWriteStream(fpath);
      r.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
      ws.on('error', reject);
    }).on('error', reject);
  });
  return { url: `/uploads/${fname}`, prompt };
}

module.exports = { generateDraft, generateImage };
