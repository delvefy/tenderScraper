import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB helpers ────────────────────────────────────────────────────────────────

const DB = {
  settings: path.join(__dirname, 'db/settings.json'),
  monitors: path.join(__dirname, 'db/monitors.json'),
  results:  path.join(__dirname, 'db/results.json'),
};

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Provider config ───────────────────────────────────────────────────────────

const PROVIDERS = {
  gemini: { label: 'Google Gemini', model: 'gemini-2.0-flash-lite', tier: 'Free tier · 30 RPM' },
  groq:   { label: 'Groq',          model: 'llama-3.3-70b-versatile', tier: 'Free tier · 30 RPM' },
  openai: { label: 'OpenAI',         model: 'gpt-4o-mini',            tier: 'Paid · 60 RPM+' },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Read settings, migrating the old single-key format if needed. */
function readSettings() {
  const raw = read(DB.settings);
  if ('apiKey' in raw && !raw.providers) {
    // Migrate from legacy { apiKey: "..." }
    return {
      activeProvider: 'gemini',
      providers: {
        gemini: { apiKey: raw.apiKey || '' },
        groq:   { apiKey: '' },
        openai: { apiKey: '' },
      },
    };
  }
  return {
    activeProvider: raw.activeProvider || 'gemini',
    providers: {
      gemini: { apiKey: raw.providers?.gemini?.apiKey || '' },
      groq:   { apiKey: raw.providers?.groq?.apiKey   || '' },
      openai: { apiKey: raw.providers?.openai?.apiKey  || '' },
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Parse the "retryDelay" hint (e.g. "21s") out of a Gemini 429 error message. */
function parseRetryDelay(errMsg) {
  try {
    const m = errMsg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    return m ? (parseFloat(m[1]) + 3) * 1000 : 65_000; // +3 s buffer, 65 s fallback
  } catch { return 65_000; }
}

// ── Scraping ──────────────────────────────────────────────────────────────────

async function scrapeUrl(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PublicTenderBot/1.0)',
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(resp.data);

    // Extract links before removing elements
    const linkMap = new Map();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
      try {
        const abs = new URL(href, url).href;
        if (!linkMap.has(abs)) linkMap.set(abs, text);
      } catch { /* skip malformed */ }
    });
    const links = [...linkMap.entries()]
      .map(([href, text]) => ({ href, text }))
      .slice(0, 80); // cap at 80 links

    // Remove script/style/nav noise
    $('script, style, nav, footer, header, noscript, iframe').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);
    return { ok: true, text, links };
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}`
      : err.code || err.message;
    return { ok: false, error: msg };
  }
}

// ── HILMA (hankintailmoitukset.fi) API connector ──────────────────────────────

async function fetchHilmaNotices(keyword) {
  // Search last 90 days of published notices (includes closed/awarded, not just currently open)
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const commonParams = {
      queryType: 'full',
      '$top': 250,
      searchMode: 'all',
      '$orderby': 'datePublished desc',
      '$count': 'true',
      '$select': 'noticeId,id,oldProcurementProjectId,procedureId,datePublished,titleFi,titleEn,organisationNameFi,organisationNameEn,descriptionFi,descriptionEn,deadline,isEForms,mainType,estimatedValue,currency,noticeResultTotalAmount,noticeResultTotalAmountCurrency,winnerOrganisations,lots',
    };
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://www.hankintailmoitukset.fi/fi/search?q=${encodeURIComponent(keyword)}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    const [byOrg, byPhrase, byKeyword] = await Promise.all([
      // Query 1: buyer/org name match
      axios.get('https://www.hankintailmoitukset.fi/search/eformnotices', {
        params: {
          ...commonParams,
          search: '*',
          '$filter': `search.ismatch('${keyword}', 'organisationNameFi,organisationNameEn') and datePublished ge ${since}`,
        },
        headers, timeout: 15000,
      }),
      // Query 2: exact phrase across ALL notice types and ALL fields (catches competitor/vendor mentions)
      axios.get('https://www.hankintailmoitukset.fi/search/eformnotices', {
        params: {
          ...commonParams,
          search: `"${keyword}"`,
          '$filter': `datePublished ge ${since}`,
        },
        headers, timeout: 15000,
      }),
      // Query 3: wildcard keyword search, contract notices only
      axios.get('https://www.hankintailmoitukset.fi/search/eformnotices', {
        params: {
          ...commonParams,
          search: `((${keyword} OR ${keyword}*))`,
          '$filter': `search.in(mainType, 'ContractNotices|NationalNotices', '|') and datePublished ge ${since}`,
        },
        headers, timeout: 15000,
      }),
    ]);

    // Merge, deduplicate by noticeId
    const seen = new Set();
    const notices = [];
    for (const n of [...(byOrg.data?.value || []), ...(byPhrase.data?.value || []), ...(byKeyword.data?.value || [])]) {
      const key = n.noticeId ?? n.id;
      if (!seen.has(key)) { seen.add(key); notices.push(n); }
    }
    const total = seen.size;
    return { ok: true, notices, total };
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.code || err.message;
    return { ok: false, error: msg, notices: [], total: 0 };
  }
}

function buildHilmaNoticeUrl(notice) {
  const base = 'https://www.hankintailmoitukset.fi/fi/public/procedure';
  if (notice.procedureId && notice.noticeId) {
    return `${base}/${notice.procedureId}/enotice/${notice.noticeId}/`;
  }
  if (notice.oldProcurementProjectId) {
    return `${base}/${notice.oldProcurementProjectId}/notice/`;
  }
  if (notice.procedureId) {
    return `${base}/${notice.procedureId}/`;
  }
  return `https://www.hankintailmoitukset.fi/fi/search?q=${encodeURIComponent(notice.titleFi || notice.titleEn || '')}`;
}

// ── AI analysis ───────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are a procurement analyst reviewing web page content.
Your job is to determine whether a page contains or announces a government/public procurement bid, tender, or RFP.
Respond ONLY in valid JSON with this exact structure:
{
  "found": true | false,
  "confidence": "high" | "medium" | "low",
  "summary": "one-sentence description of what was found (or why nothing was found)",
  "links": ["array of direct URLs to specific matching tenders, notices, or procedures found on the page — empty array if none"]
}`;

function buildPrompt(customPrompt, url, pageText, links = []) {
  const linksSection = links.length
    ? `\n\nLinks extracted from page:\n${links.map(l => `- ${l.href}${l.text ? ` (${l.text})` : ''}`).join('\n').slice(0, 3000)}`
    : '';
  return `URL: ${url}\n\nUser instruction: ${customPrompt}\n\nPage content:\n${pageText}${linksSection}`;
}

async function analyseWithGemini(apiKey, customPrompt, url, pageText, links) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt(customPrompt, url, pageText, links);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: PROVIDERS.gemini.model,
        contents: prompt,
        config: { systemInstruction: SYSTEM_INSTRUCTION },
      });
      const raw = result.text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in Gemini response');
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (attempt === 1 && is429) {
        const wait = parseRetryDelay(err.message ?? '');
        console.log(`[gemini] 429 — retrying in ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

async function analyseWithOpenAI(providerId, apiKey, customPrompt, url, pageText, links) {
  const clientOpts = { apiKey };
  if (providerId === 'groq') clientOpts.baseURL = 'https://api.groq.com/openai/v1';
  const client = new OpenAI(clientOpts);
  const model = PROVIDERS[providerId].model;
  const userMsg = buildPrompt(customPrompt, url, pageText, links);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user',   content: userMsg },
        ],
      });
      return JSON.parse(resp.choices[0].message.content);
    } catch (err) {
      const is429 = err.status === 429 || err.message?.includes('429');
      if (attempt === 1 && is429) {
        const retryAfter = parseInt(err.headers?.['retry-after'] ?? '60', 10);
        console.log(`[${providerId}] 429 — retrying in ${retryAfter}s…`);
        await sleep((retryAfter + 3) * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function analyseWithAI(settings, customPrompt, url, pageText, links) {
  const { activeProvider, providers } = settings;
  const apiKey = providers[activeProvider]?.apiKey;
  if (!apiKey) throw new Error(`No API key configured for provider "${activeProvider}"`);
  if (activeProvider === 'gemini') return analyseWithGemini(apiKey, customPrompt, url, pageText, links);
  return analyseWithOpenAI(activeProvider, apiKey, customPrompt, url, pageText, links);
}

// ── Run a monitor ─────────────────────────────────────────────────────────────

async function runMonitor(monitor) {
  const settings = readSettings();
  const activeKey = settings.providers[settings.activeProvider]?.apiKey;
  if (!activeKey) {
    console.error(`[monitor] No API key for active provider "${settings.activeProvider}"`);
    return;
  }

  const runAt = new Date().toISOString();
  console.log(`[monitor] Running "${monitor.name}" via ${settings.activeProvider} at ${runAt}`);

  const findings = [];

  if (monitor.hilmaKeyword) {
    // ── HILMA API path ─────────────────────────────────────────────────────────
    console.log(`[hilma] Querying HILMA for "${monitor.hilmaKeyword}"…`);
    const result = await fetchHilmaNotices(monitor.hilmaKeyword);

    if (!result.ok) {
      findings.push({ url: 'https://www.hankintailmoitukset.fi', found: false, error: result.error, summary: `HILMA API error: ${result.error}` });
    } else {
      // Pre-filter priority:
      // 1. Exact org name match  → buyer search (e.g. "Tulli")
      // 2. Partial org name match → loose buyer search
      // 3. No org match at all   → vendor/competitor search: keep ALL API results
      //    (API already did full-text search, so every returned notice mentions the keyword)
      const kw = monitor.hilmaKeyword.toLowerCase().trim();
      const exactOrg = result.notices.filter(n =>
        (n.organisationNameFi || '').toLowerCase() === kw ||
        (n.organisationNameEn || '').toLowerCase() === kw
      );
      const partialOrg = result.notices.filter(n =>
        (n.organisationNameFi || '').toLowerCase().includes(kw) ||
        (n.organisationNameEn || '').toLowerCase().includes(kw)
      );
      // Also match on winner field — catches competitor-won contracts
      const winnerMatch = result.notices.filter(n =>
        (n.winnerOrganisations || '').toLowerCase().includes(kw) ||
        (n.lots || []).some(l => (l.winnerOrganisations || '').toLowerCase().includes(kw))
      );
      const candidates = (
        exactOrg.length > 0   ? exactOrg  :
        partialOrg.length > 0 ? partialOrg :
        winnerMatch.length > 0 ? winnerMatch :
        result.notices   // full-text keyword — use everything the API returned
      ).slice(0, 20);

      console.log(`[hilma] ${result.total} total results → ${candidates.length} after org/title filter`);

      if (candidates.length === 0) {
        findings.push({
          url: `https://www.hankintailmoitukset.fi/fi/search?q=${encodeURIComponent(monitor.hilmaKeyword)}`,
          found: false,
          summary: `No active notices matched "${monitor.hilmaKeyword}" (${result.total} total results before filtering).`,
          links: [],
        });
      }

      for (let i = 0; i < candidates.length; i++) {
        const notice = candidates[i];
        const url = buildHilmaNoticeUrl(notice);
        const title = notice.titleFi || notice.titleEn || 'Untitled';
        const org   = notice.organisationNameFi || notice.organisationNameEn || 'Unknown org';
        const desc  = notice.descriptionFi || notice.descriptionEn || '';
        const deadline = notice.deadline ? new Date(notice.deadline).toLocaleDateString('fi-FI') : 'N/A';

        // Collect winner and value info from lots or top-level fields
        const winners = [
          ...(notice.winnerOrganisations ? [notice.winnerOrganisations] : []),
          ...(notice.lots || []).map(l => l.winnerOrganisations).filter(Boolean),
        ].filter((v, i, a) => a.indexOf(v) === i).join('; ');
        const lotValue = (notice.lots || []).reduce((sum, l) => sum + (l.lotResultTotalAmount || 0), 0) || null;
        const totalValue = notice.noticeResultTotalAmount || lotValue;
        const valueCurrency = notice.noticeResultTotalAmountCurrency || (notice.lots?.[0]?.lotResultTotalAmountCurrency) || 'EUR';
        const contractExpiry = (notice.lots || []).map(l => l.expirationDate).filter(Boolean).sort().pop() || null;

        // Feed the structured fields as plain text to the AI
        const pageText = `Title: ${title}\nOrganization: ${org}\nDescription: ${desc}\nDeadline: ${deadline}\nPublished: ${notice.datePublished || 'N/A'}\nType: ${notice.mainType || 'N/A'}${winners ? `\nWinner/Provider: ${winners}` : ''}${totalValue ? `\nContract Value: ${totalValue.toLocaleString()} ${valueCurrency}` : ''}`;

        try {
          const analysis = await analyseWithAI(settings, monitor.prompt, url, pageText, []);
          findings.push({
            url,
            found: analysis.found,
            confidence: analysis.confidence,
            summary: analysis.summary,
            links: [url],
            hilma: { title, org, deadline: notice.deadline, published: notice.datePublished, winners, totalValue, valueCurrency, contractExpiry },
          });
        } catch (err) {
          findings.push({ url, found: false, error: err.message, summary: `Analysis failed: ${err.message}`, hilma: { title, org } });
        }

        if (i < candidates.length - 1) await sleep(4500);
      }
    }

  } else if (!monitor.sites || monitor.sites.length === 0) {
    console.error(`[monitor] "${monitor.name}" has no sites and no hilmaKeyword — nothing to run`);
    findings.push({ url: '', found: false, error: 'misconfigured', summary: 'Monitor has no sites and no HILMA keyword configured. Edit the monitor to fix this.' });

  } else {
    // ── Standard URL scraping path ─────────────────────────────────────────────
    for (let i = 0; i < monitor.sites.length; i++) {
      const url = monitor.sites[i];
      const scraped = await scrapeUrl(url);
      if (!scraped.ok) {
        findings.push({ url, found: false, error: scraped.error, summary: `Scrape failed: ${scraped.error}` });
      } else {
        try {
          const analysis = await analyseWithAI(settings, monitor.prompt, url, scraped.text, scraped.links);
          findings.push({
            url,
            found: analysis.found,
            confidence: analysis.confidence,
            summary: analysis.summary,
            links: Array.isArray(analysis.links) ? analysis.links.filter(l => typeof l === 'string' && l.startsWith('http')) : [],
          });
        } catch (err) {
          findings.push({ url, found: false, error: err.message, summary: `Analysis failed: ${err.message}` });
        }
      }
      if (i < monitor.sites.length - 1) await sleep(4500);
    }
  }

  const results = read(DB.results);
  results.unshift({ id: uuidv4(), monitorId: monitor.id, runAt, provider: settings.activeProvider, findings });
  if (results.length > 500) results.length = 500;
  write(DB.results, results);

  const monitors = read(DB.monitors);
  const idx = monitors.findIndex(m => m.id === monitor.id);
  if (idx !== -1) {
    monitors[idx].lastRunAt = runAt;
    monitors[idx].lastRunStatus = findings.some(f => f.found) ? 'found' : 'none';
    write(DB.monitors, monitors);
  }

  console.log(`[monitor] "${monitor.name}" done — ${findings.filter(f => f.found).length}/${findings.length} sites matched`);
}


// ── Routes ────────────────────────────────────────────────────────────────────

// Settings
app.get('/api/settings', (_req, res) => {
  const s = readSettings();
  res.json({
    activeProvider: s.activeProvider,
    providers: Object.fromEntries(
      PROVIDER_IDS.map(id => [id, { hasKey: Boolean(s.providers[id]?.apiKey), ...PROVIDERS[id] }])
    ),
  });
});

app.post('/api/settings', (req, res) => {
  const { activeProvider, providers } = req.body;
  const s = readSettings();
  if (typeof activeProvider === 'string' && PROVIDER_IDS.includes(activeProvider)) {
    s.activeProvider = activeProvider;
  }
  if (providers && typeof providers === 'object') {
    for (const id of PROVIDER_IDS) {
      if (typeof providers[id]?.apiKey === 'string') {
        s.providers[id] = { apiKey: providers[id].apiKey.trim() };
      }
    }
  }
  write(DB.settings, s);
  res.json({ ok: true });
});

// Monitors
app.get('/api/monitors', (_req, res) => {
  res.json(read(DB.monitors));
});

app.post('/api/monitors', (req, res) => {
  const { name, sites, prompt, interval, active, hilmaKeyword } = req.body;
  if (!name || (!sites && !hilmaKeyword) || !prompt) return res.status(400).json({ error: 'name, prompt, and either sites or hilmaKeyword required' });

  const monitor = {
    id: uuidv4(),
    name,
    hilmaKeyword: hilmaKeyword?.trim() || null,
    sites: hilmaKeyword ? [] : (Array.isArray(sites) ? sites : (sites || '').split('\n').map(s => s.trim()).filter(Boolean)),
    prompt,
    interval: interval ?? '24h',
    active: active !== false,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
  };
  const monitors = read(DB.monitors);
  monitors.push(monitor);
  write(DB.monitors, monitors);
  res.json(monitor);
});

app.put('/api/monitors/:id', (req, res) => {
  const monitors = read(DB.monitors);
  const idx = monitors.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { name, sites, prompt, interval, active, hilmaKeyword } = req.body;
  const updated = {
    ...monitors[idx],
    ...(name !== undefined && { name }),
    ...(hilmaKeyword !== undefined && { hilmaKeyword: hilmaKeyword?.trim() || null }),
    ...(sites !== undefined && { sites: Array.isArray(sites) ? sites : sites.split('\n').map(s => s.trim()).filter(Boolean) }),
    ...(prompt !== undefined && { prompt }),
    ...(interval !== undefined && { interval }),
    ...(active !== undefined && { active }),
  };
  monitors[idx] = updated;
  write(DB.monitors, monitors);
  res.json(updated);
});

app.delete('/api/monitors/:id', (req, res) => {
  const monitors = read(DB.monitors);
  const idx = monitors.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  monitors.splice(idx, 1);
  write(DB.monitors, monitors);
  res.json({ ok: true });
});

// Run now
app.post('/api/monitors/:id/run', async (req, res) => {
  const monitors = read(DB.monitors);
  const monitor = monitors.find(m => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, message: 'Run started' });
  // Run async after response
  runMonitor(monitor).catch(err => console.error('[run-now]', err));
});

// Debug: test HILMA API for a keyword
app.get('/api/debug/hilma', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword query param required' });
  const result = await fetchHilmaNotices(keyword);
  if (!result.ok) return res.json({ ok: false, error: result.error });
  const kw = keyword.toLowerCase().trim();
  const exactOrg  = result.notices.filter(n => (n.organisationNameFi || '').toLowerCase() === kw || (n.organisationNameEn || '').toLowerCase() === kw);
  const partialOrg = result.notices.filter(n => (n.organisationNameFi || '').toLowerCase().includes(kw) || (n.organisationNameEn || '').toLowerCase().includes(kw));
  const filtered = exactOrg.length > 0 ? exactOrg : partialOrg.length > 0 ? partialOrg : result.notices;
  const filterMode = exactOrg.length > 0 ? 'exact-org' : partialOrg.length > 0 ? 'partial-org' : 'full-text-all';
  res.json({
    ok: true,
    total: result.total,
    returned: result.notices.length,
    filterMode,
    afterFilter: filtered.length,
    sample: filtered.slice(0, 5).map(n => ({
      title: n.titleFi || n.titleEn,
      org: n.organisationNameFi || n.organisationNameEn,
      winner: n.winnerOrganisations || (n.lots || []).map(l => l.winnerOrganisations).filter(Boolean).join('; ') || null,
      totalValue: n.noticeResultTotalAmount || (n.lots || []).reduce((s, l) => s + (l.lotResultTotalAmount || 0), 0) || null,
      currency: n.noticeResultTotalAmountCurrency || n.lots?.[0]?.lotResultTotalAmountCurrency || null,
      contractExpiry: (n.lots || []).map(l => l.expirationDate).filter(Boolean).sort().pop() || null,
      deadline: n.deadline,
      published: n.datePublished,
      type: n.mainType,
      url: buildHilmaNoticeUrl(n),
    })),
  });
});

// Debug: test what the scraper sees on a URL
app.get('/api/debug/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  const result = await scrapeUrl(url);
  if (!result.ok) return res.json({ ok: false, error: result.error });
  res.json({
    ok: true,
    textLength: result.text.length,
    textPreview: result.text.slice(0, 500),
    linkCount: result.links.length,
    links: result.links.slice(0, 30),
  });
});

// Results
app.get('/api/results', (req, res) => {
  const { monitorId, limit = 50 } = req.query;
  let results = read(DB.results);
  if (monitorId) results = results.filter(r => r.monitorId === monitorId);
  res.json(results.slice(0, Number(limit)));
});

app.delete('/api/results', (_req, res) => {
  write(DB.results, []);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`PublicTender running at http://localhost:${PORT}`);
});
