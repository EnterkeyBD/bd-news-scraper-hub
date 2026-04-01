#!/usr/bin/env node
'use strict';

/**
 * Prothom Alo Scraper â€“ Node.js
 * Ported from prothomalo-scraper/scrapprothomalo_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active prothomalo categories from MySQL
 *  - Extracts article links via JSON API:
 *      GET /api/v1/collections/{slug}?offset={offset}&limit=20
 *    - Derives slug from the last path segment of category_url
 *    - If page 1 returns no story items (manual layout collection),
 *      retries with "{slug}-all" sub-collection automatically
 *    - Stops pagination at 3 consecutive articles older than cutoff
 *  - Article URLs built as base_url + '/' + story.slug
 *  - Published-at: API millisecond timestamp (no Bengali date parsing)
 *  - Article page scraping:
 *      headline: <h1>
 *      date:     JSON-LD NewsArticle.datePublished (ISO 8601)
 *      image:    JSON-LD image.url â†’ og:image â†’ twitter:image
 *                â†’ article/story img â†’ figure img â†’ picture img
 *      image URL: overlay/crop params stripped from media.prothomalo.com URLs
 *      content:  div[class*="story-element-text"] paragraphs joined
 *  - Retries failed articles each cycle (max 10 attempts)
 *  - Exponential back-off on HTTP 408/429/5xx and network errors (3 attempts)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] and âœ“ article tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');
const url_lib = require('url');

// â”€â”€ Paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PROJ_ROOT      = path.resolve(__dirname, '..', '..');
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'prothomalo.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'prothomalo');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600;

// â”€â”€ DB Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DB_CONFIG = {
  host:               '103.213.38.238',
  port:               3306,
  user:               'siamvidb_scraptestg',
  password:           'HuHmf!w=E]%I=3L&',
  database:           'siamvidb_scraptestg',
  charset:            'utf8mb4',
  connectTimeout:     30000,
  waitForConnections: true,
  connectionLimit:    3,
};

// â”€â”€ Site config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BASE_URL    = 'https://www.prothomalo.com';
const BASE_DOMAIN = 'www.prothomalo.com';

const SECTION_TO_CATEGORY_ID = {
  politics:      10,
  bangladesh:    5,
  economics:     9,
  business:      9,
  international: 6,
  world:         6,
  sports:        8,
  entertainment: 14,
  opinion:       12,
  chakri:        11,
  lifestyle:     13,
};

// Temporary HTTP status codes worth retrying
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// â”€â”€ User agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// â”€â”€ Tiny helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function log(msg)   { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function pad2(n)    { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// â”€â”€ Retry with exponential backoff â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function retryWithBackoff(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isRetryable = e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED'
        || (e.response && RETRY_STATUSES.has(e.response.status));
      if (!isRetryable || attempt === maxAttempts - 1) throw e;
      const delay = Math.min(2 * Math.pow(2, attempt), 30) * 1000;
      log(`   [RETRY] Attempt ${attempt+1}/${maxAttempts} after ${delay/1000}s - ${String(e.message).substring(0, 50)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// â”€â”€ Image URL cleaner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Remove overlay/crop/social-sharing query params from media.prothomalo.com URLs.
 * Ensures 'w' (width) and 'auto' params are present.
 */
function cleanImageUrl(rawUrl) {
  if (!rawUrl || !rawUrl.includes('media.prothomalo.com')) return rawUrl;
  try {
    const parsed = new url_lib.URL(rawUrl);
    const REMOVE = new Set(['overlay','overlay_position','overlay_width_pct','rect','mode','ar','ogImage']);
    for (const key of REMOVE) parsed.searchParams.delete(key);
    if (!parsed.searchParams.has('w')) parsed.searchParams.set('w', '800');
    if (!parsed.searchParams.has('auto')) parsed.searchParams.set('auto', 'format,compress');
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

// â”€â”€ Cycle time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['prothomalo'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// â”€â”€ Last-processed dates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadLastProcessedDates() {
  try {
    if (fs.existsSync(LAST_PROC_FILE))
      return JSON.parse(fs.readFileSync(LAST_PROC_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveLastProcessedDates(data) {
  fs.writeFileSync(LAST_PROC_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// â”€â”€ DB pool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function urlExists(url) {
  const [rows] = await getPool().execute(
    'SELECT COUNT(*) AS cnt FROM articles WHERE source_url = ?', [url]);
  return rows[0].cnt > 0;
}

async function getArticleByUrl(url) {
  const [rows] = await getPool().execute(
    'SELECT * FROM articles WHERE source_url = ?', [url]);
  return rows[0] || null;
}

async function insertArticle({ headline, isoDate, content, imageName, url, tags, category, section }) {
  let pubDt = null;
  if (isoDate) {
    try { pubDt = new Date(isoDate); if (isNaN(pubDt)) pubDt = null; } catch (_) {}
  }
  const [result] = await getPool().execute(
    `INSERT INTO articles
       (headline, actual_headline, published_at, content, image_name,
        source_url, source_site, tags, category, section,
        scraping_status, processing_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Success',1)`,
    [headline, headline, pubDt, content || '', imageName || null,
     url, BASE_DOMAIN, tags || '', String(category), section]);
  return result.insertId;
}

async function updateArticleSuccess(id, { headline, isoDate, content, imageName, tags, category, section }) {
  let pubDt = null;
  if (isoDate) {
    try { pubDt = new Date(isoDate); if (isNaN(pubDt)) pubDt = null; } catch (_) {}
  }
  await getPool().execute(
    `UPDATE articles
        SET headline=?, actual_headline=?, published_at=?, content=?,
            image_name=?, source_site=?, tags=?, category=?, section=?,
            scraping_status='Success',
            processing_count=processing_count+1
      WHERE id=?`,
    [headline, headline, pubDt, content || '', imageName || null,
     BASE_DOMAIN, tags || '', String(category), section, id]);
}

async function insertFailedUrl(url, section, errMsg) {
  try {
    await getPool().execute(
      `INSERT INTO articles
         (headline, actual_headline, published_at, content, image_name,
          source_url, source_site, tags, category, section,
          scraping_status, processing_count)
       VALUES ('Failed to scrape',NULL,NULL,NULL,NULL,?,?,?,?,?,'Failed',1)`,
      [url, BASE_DOMAIN, `Error: ${errMsg}`, 'Not Available', section]);
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
  }
}

async function updateArticleFailed(id, errMsg) {
  await getPool().execute(
    `UPDATE articles SET scraping_status='Failed', processing_count=processing_count+1, tags=? WHERE id=?`,
    [`Error: ${errMsg}`, id]);
}

async function getFailedArticles(maxRetries, site) {
  const [rows] = await getPool().execute(
    `SELECT * FROM articles WHERE scraping_status='Failed' AND processing_count < ? AND source_site = ?`,
    [maxRetries, site]);
  return rows;
}

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories WHERE site='prothomalo' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  const [rows] = await getPool().execute(
    `SELECT autorun FROM scraper_autorun WHERE site='prothomalo'`);
  return rows[0] ? rows[0].autorun : 1;
}

// â”€â”€ Headline dedup map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HEADLINE_TO_ID = {};

async function loadHeadlineMap() {
  const [rows] = await getPool().execute(
    `SELECT id, actual_headline FROM articles WHERE actual_headline IS NOT NULL AND actual_headline != ''`);
  for (const r of rows) HEADLINE_TO_ID[r.actual_headline] = r.id;
}

// â”€â”€ Image folder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/')) imageUrl = BASE_URL + imageUrl;

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': randomUA() },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `prothomalo_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded and processed image: ${fname}`);
    return fname;
  } catch (e) {
    log(`   [ERROR] Image download failed: ${String(e.message).substring(0, 50)}`);
    return null;
  }
}

// â”€â”€ API link extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates) {
  // Derive slug from last URL segment
  const apiSlug = categoryUrl.replace(/\/$/, '').split('/').pop();
  log(`\n[INFO] Extracting links from ${sectionLabel} (api_slug=${apiSlug})`);

  const lastDatetime = lastProcessedDates[sectionLabel];
  let cutoffStr;
  if (!lastDatetime) {
    const today = new Date();
    cutoffStr = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())} 00:00:00`;
    log(`   [INFO] No last run timestamp, looking for today's articles: ${cutoffStr.split(' ')[0]}`);
  } else {
    cutoffStr = lastDatetime;
    log(`   [INFO] Looking for articles published after: ${cutoffStr}`);
  }

  const links = [];
  let offset = 0;
  let page = 1;
  let consecutiveOld = 0;
  let effectiveSlug = apiSlug;

  while (page <= 50) {
    try {
      const apiUrl = `${BASE_URL}/api/v1/collections/${effectiveSlug}?offset=${offset}&limit=20`;
      const resp = await retryWithBackoff(() => axios.get(apiUrl, {
        timeout: 15000,
        headers: { 'User-Agent': randomUA(), 'Accept': 'application/json', 'Referer': categoryUrl },
      }));

      const data = resp.data || {};
      let items = data.items || [];

      if (!items.length) {
        log(`   [INFO] No more items at offset ${offset}`);
        break;
      }

      // Detect manual layout collection (no story items on page 1) â†’ retry with "{slug}-all"
      if (page === 1 && !items.some(item => item.type === 'story')) {
        const fallbackSlug = `${apiSlug}-all`;
        log(`   [INFO] Collection '${effectiveSlug}' has no story items (manual layout). Retrying with '${fallbackSlug}'...`);
        effectiveSlug = fallbackSlug;
        try {
          const fbResp = await retryWithBackoff(() => axios.get(
            `${BASE_URL}/api/v1/collections/${effectiveSlug}?offset=${offset}&limit=20`,
            { timeout: 15000, headers: { 'User-Agent': randomUA(), 'Accept': 'application/json' } }
          ));
          items = fbResp.data?.items || [];
        } catch (e) {
          log(`   [ERROR] Fallback '${fallbackSlug}' failed: ${e.message}`);
          break;
        }
        if (!items.length) {
          log(`   [INFO] No items in fallback collection '${fallbackSlug}'`);
          break;
        }
      }

      let newLinks = 0;
      let stopPagination = false;

      for (const item of items) {
        if (item.type !== 'story') continue;
        const story = item.story || {};
        const slug  = story.slug;
        const pubAt = story['published-at'];
        if (!slug || !pubAt) continue;

        const articleUrl  = `${BASE_URL}/${slug}`;
        const dt          = new Date(pubAt); // ms timestamp
        const datetimeStr = `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;

        if (datetimeStr <= cutoffStr) {
          consecutiveOld++;
          log(`   [OLD] ${datetimeStr} (${consecutiveOld}/3)`);
          if (consecutiveOld >= 3) {
            log(`   [STOP] 3 consecutive old articles â€” stopping pagination`);
            stopPagination = true;
            break;
          }
          continue;
        }

        consecutiveOld = 0;
        links.push(articleUrl);
        newLinks++;
      }

      log(`   [PAGE ${page}] Found ${newLinks} new articles (offset=${offset})`);

      if (stopPagination || newLinks === 0) break;

      offset += 20;
      page++;
      await sleep(1000);
    } catch (e) {
      log(`   [ERROR] API request failed: ${String(e.message).substring(0, 100)}`);
      break;
    }
  }

  log(`   [TOTAL] ${links.length} new links`);
  return links;
}

// â”€â”€ Article scraping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeArticle(articleUrl) {
  try {
    const resp = await retryWithBackoff(() => axios.get(articleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent':      randomUA(),
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
      },
    }));

    const $ = cheerio.load(resp.data);

    // Headline
    const headline = $('h1').first().text().trim() || null;

    // Date and image from JSON-LD
    let publishedDate = null;
    let imageUrl = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      if (publishedDate !== null && imageUrl !== null) return;
      try {
        const data = JSON.parse($(el).html() || '{}');
        if (data['@type'] === 'NewsArticle') {
          // Date
          if (!publishedDate && data.datePublished) {
            const dt = new Date(data.datePublished);
            if (!isNaN(dt)) {
              publishedDate = `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
            }
          }
          // Image
          if (!imageUrl) {
            const imgData = data.image;
            if (imgData) {
              const raw = typeof imgData === 'object' ? imgData.url : imgData;
              if (raw && !raw.toLowerCase().includes('null') && raw.length > 10) {
                imageUrl = cleanImageUrl(raw);
              }
            }
          }
        }
      } catch (_) {}
    });

    // Fallback: og:image
    if (!imageUrl || imageUrl.toLowerCase().includes('null')) {
      const meta = $('meta[property="og:image"]').attr('content');
      if (meta) imageUrl = cleanImageUrl(meta);
    }

    // Fallback: twitter:image
    if (!imageUrl || imageUrl.toLowerCase().includes('null')) {
      const meta = $('meta[name="twitter:image"]').attr('content');
      if (meta) imageUrl = cleanImageUrl(meta);
    }

    // Fallback: article/story img
    if (!imageUrl || imageUrl.toLowerCase().includes('null')) {
      const area = $('article').first().length ? $('article').first() : $('div[class*="story"]').first();
      const img  = area.find('img').first();
      imageUrl = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || null;
    }

    // Fallback: figure img
    if (!imageUrl || imageUrl.toLowerCase().includes('null')) {
      const img = $('figure img').first();
      imageUrl = img.attr('src') || img.attr('data-src') || null;
    }

    // Fallback: picture img
    if (!imageUrl || imageUrl.toLowerCase().includes('null')) {
      const img = $('picture img').first();
      imageUrl = img.attr('src') || img.attr('data-src') || null;
    }

    // Final validation
    if (imageUrl && (imageUrl.toLowerCase().includes('null') || imageUrl.length < 10)) imageUrl = null;

    // Content: div[class*="story-element-text"]
    const contentParts = [];
    $('div').filter((_, el) => {
      const cls = $(el).attr('class') || '';
      return cls.includes('story-element-text');
    }).each((_, el) => {
      const text = $(el).text().trim();
      if (text) contentParts.push(text);
    });
    const content = contentParts.join(' ') || null;

    const imageName = imageUrl ? await downloadImage(imageUrl) : null;

    return { headline, content, date: publishedDate || nowStr(), image: imageName };
  } catch (e) {
    log(`   [ERROR] Scraping failed: ${String(e.message).substring(0, 100)}`);
    return null;
  }
}

// â”€â”€ Category ID resolver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getCategoryId(sectionLabel) {
  // Strip any 'prothomalo-' prefix
  const key = sectionLabel.replace(/^prothomalo-/, '');
  return SECTION_TO_CATEGORY_ID[key] || SECTION_TO_CATEGORY_ID[sectionLabel] || 7;
}

// â”€â”€ Process a single URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processArticle(url, sectionLabel, existingRow) {
  try {
    existingRow = existingRow || await getArticleByUrl(url);
    if (existingRow) {
      const status = existingRow.scraping_status;
      const count  = existingRow.processing_count || 0;
      if (status === 'Success') { log(`   [SKIP] Already processed (success): ${url}`); return true; }
      if (status === 'Failed' && count >= 10) { log(`   [SKIP] Max retries reached (${count}/10): ${url}`); return false; }
    }

    const articleData = await scrapeArticle(url);
    if (!articleData || !articleData.headline) {
      log(`   [ERROR] Failed to scrape content`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Failed to scrape content');
      else await insertFailedUrl(url, sectionLabel, 'Failed to scrape content');
      return false;
    }

    const { headline, content, date: isoDate, image: imageName } = articleData;
    const catId = getCategoryId(sectionLabel);

    const existingId = HEADLINE_TO_ID[headline];
    if (existingId) {
      await updateArticleSuccess(existingId, { headline, isoDate, content: content || '', imageName, tags: '', category: catId, section: sectionLabel });
      log(`   [OK] Updated existing article (id ${existingId})`);
    } else {
      const newId = await insertArticle({ headline, isoDate, content: content || '', imageName, url, tags: '', category: catId, section: sectionLabel });
      if (newId) {
        HEADLINE_TO_ID[headline] = newId;
        log(`   [OK] Inserted new article (id ${newId})`);
      } else {
        log(`   [ERROR] Insert returned null`);
        return false;
      }
    }

    return true;
  } catch (e) {
    log(`   [ERROR] Processing failed: ${String(e.message).substring(0, 100)}`);
    try { await insertFailedUrl(url, sectionLabel, String(e.message)); } catch (_) {}
    return false;
  }
}

// â”€â”€ Main loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('PROTHOM ALO NEWS SCRAPER - MYSQL DATABASE');
  log('='.repeat(70));
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

  ensureImgFolder();

  try { await loadHeadlineMap(); } catch (e) { log(`[WARNING] Could not load headline map: ${e.message}`); }

  let lastProcessedDates = loadLastProcessedDates();

  while (true) {
    CYCLE_TIME = getCycleTime();

    let categories = [];
    try {
      categories = await getActiveCategories();
    } catch (e) {
      log(`Error loading categories: ${e.message}. Waiting 60s...`);
      await sleep(60000);
      continue;
    }

    if (!categories.length) {
      log('No active Prothom Alo categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Prothom Alo categories`);

    // Retry failed
    log('[STATUS:finding:Checking for failed articles]');
    try {
      const failedRows = await getFailedArticles(10, BASE_DOMAIN);
      if (failedRows.length) {
        log(`\n${'='.repeat(70)}`);
        log(`RETRYING ${failedRows.length} FAILED URLs`);
        log('='.repeat(70));
        for (const row of failedRows) {
          const url     = row.source_url;
          const section = row.section || 'politics';
          const attempt = (row.processing_count || 0) + 1;
          log(`\nRetrying failed URL (attempt ${attempt}/10): ${url}`);
          const ok = await processArticle(url, section, row);
          log(ok ? `âœ… Retry succeeded => ${url}` : `âŒ Retry still failing => ${url}`);
        }
      }
    } catch (e) {
      log(`[WARNING] Error retrying failed articles: ${e.message}`);
    }

    const cycleStart = Date.now();
    log(`\n${'='.repeat(70)}`);
    log(`Starting new cycle at ${nowStr()}`);
    log('='.repeat(70) + '\n');

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      log(`\n${'='.repeat(70)}`);
      log(`CATEGORY: ${sectionLabel.toUpperCase()}`);
      log('='.repeat(70));

      const cycleSecStart = nowStr();

      log(`[STATUS:finding:Searching ${sectionLabel}]`);
      const articleLinks = await extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates);

      const newLinks = [];
      for (const u of articleLinks) {
        if (!(await urlExists(u))) newLinks.push(u);
      }
      log(`   [INFO] Found ${articleLinks.length} total links (${newLinks.length} new, ${articleLinks.length - newLinks.length} already in DB)`);

      if (!newLinks.length) {
        log(`   [INFO] No new articles for ${sectionLabel}`);
        lastProcessedDates[sectionLabel] = cycleSecStart;
        saveLastProcessedDates(lastProcessedDates);
        continue;
      }

      log(`\n[SCRAPING] Processing ${newLinks.length} new articles...`);

      for (let idx = 0; idx < newLinks.length; idx++) {
        const u = newLinks[idx];
        log(`[STATUS:extracting:${idx+1}/${newLinks.length}]`);
        log(`\n[${idx+1}/${newLinks.length}] ${u}`);
        try {
          await processArticle(u, sectionLabel);
          await sleep(2000);
        } catch (e) {
          log(`   [ERROR] ${String(e.message).substring(0, 100)}`);
        }
      }

      lastProcessedDates[sectionLabel] = cycleSecStart;
      saveLastProcessedDates(lastProcessedDates);

      log(`Completed processing for ${sectionLabel}. Pausing briefly...`);
      await sleep(2000);
    }

    const cycleDuration = Math.floor((Date.now() - cycleStart) / 1000);

    // Autorun check
    try {
      const autorun = await getAutorun();
      if (autorun === 0) {
        log('[AUTORUN OFF] Autorun is disabled. Scraper completed one cycle and will now stop.');
        break;
      }
    } catch (e) {
      log(`[WARNING] Could not check autorun setting: ${e.message}`);
    }

    if (cycleDuration < CYCLE_TIME) {
      const waitTime = CYCLE_TIME - cycleDuration;
      log(`\nCompleted cycle in ${cycleDuration}s. Waiting ${waitTime}s before next cycle...`);
      for (let remaining = waitTime; remaining > 0; remaining--) {
        log(`[STATUS:waiting:${remaining}]`);
        await sleep(1000);
      }
      log('\nStarting new cycle!\n');
    } else {
      log('\nCycle took longer than target interval. Starting next cycle immediately...\n');
    }
  }

  if (pool) await pool.end();
}

main().catch(e => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
