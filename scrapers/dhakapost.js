#!/usr/bin/env node
'use strict';

/**
 * Dhaka Post Scraper â€“ Node.js
 * Ported from dhakapost-scraper/scrapdhakapost_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active dhakapost categories from MySQL
 *  - Two-source hybrid link extraction (no AJAX pagination â€“ Next.js site):
 *      1. Sitemap: GET /{slug}/sitemaps.xml  â†’ <loc>+<lastmod> filtering by cutoff
 *      2. HTML page scrape: regex /{slug}/(\d+) on raw HTML to catch latest articles
 *  - Article page scraping:
 *      headline:  <h1>
 *      date:      meta[property="article:published_time"] â†’ JSON-LD datePublished â†’ <time datetime>
 *      image:     link[rel=preload][as=image] (cdn.dhakapost.com/media/imgAll)
 *                 â†’ img[class*=w-full] â†’ JSON-LD image â†’ og:image (same CDN path only)
 *      content:   div[class*="news-details"] paragraphs; fallback main/article
 *      tags:      meta[property="article:tag"] (comma-split); fallback a[href*="/topic/"]
 *  - Retries failed articles each cycle (max 10 attempts)
 *  - Exponential back-off on HTTP 408/429/5xx and network errors (3 attempts)
 *  - Article-level date guard: skip articles older than last run timestamp
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// â”€â”€ Paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PROJ_ROOT      = path.resolve(__dirname, '..', '..');
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'dhakapost.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'dhakapost');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600;

// â”€â”€ DB Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Site config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BASE_URL    = 'https://www.dhakapost.com';
const BASE_DOMAIN = 'www.dhakapost.com';

const SECTION_TO_CATEGORY_ID = {
  national:      5,
  politics:      10,
  business:      9,
  world:         6,
  sports:        8,
  entertainment: 14,
  country:       11,
  capital:       12,
  bangladesh:    5,
  economy:       9,
  international: 6,
  opinion:       7,
};

const DEFAULT_CATEGORIES = [
  { category_url: 'https://www.dhakapost.com/politics',       section_label: 'dhakapost-politics'       },
  { category_url: 'https://www.dhakapost.com/national',       section_label: 'dhakapost-national'       },
  { category_url: 'https://www.dhakapost.com/international',  section_label: 'dhakapost-international'  },
  { category_url: 'https://www.dhakapost.com/economy',        section_label: 'dhakapost-economy'        },
  { category_url: 'https://www.dhakapost.com/sports',         section_label: 'dhakapost-sports'         },
  { category_url: 'https://www.dhakapost.com/entertainment',  section_label: 'dhakapost-entertainment'  },
  { category_url: 'https://www.dhakapost.com/opinion',        section_label: 'dhakapost-opinion'        },
  { category_url: 'https://www.dhakapost.com/country',        section_label: 'dhakapost-country'        },
];

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// â”€â”€ Tiny helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function log(msg)   { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)    { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function randomUA() {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];
  return UAS[Math.floor(Math.random() * UAS.length)];
}

// â”€â”€ Retry with exponential backoff â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Browser-like headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function browserHeaders(referer) {
  return {
    'User-Agent':                randomUA(),
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9,bn;q=0.8',
    'Cache-Control':             'no-cache',
    'Sec-Ch-Ua':                 '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile':          '?0',
    'Sec-Ch-Ua-Platform':        '"Windows"',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { 'Referer': referer } : {}),
  };
}

// â”€â”€ Cycle time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['dhakapost'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// â”€â”€ Last-processed dates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ DB pool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

async function getFailedArticles(maxRetries) {
  const [rows] = await getPool().execute(
    `SELECT * FROM articles WHERE scraping_status='Failed' AND processing_count < ? AND source_site = ?`,
    [maxRetries, BASE_DOMAIN]);
  return rows;
}

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories WHERE site='dhakapost' AND is_active=1`);
  return rows;
}

async function ensureDefaultCategories() {
  for (const { category_url, section_label } of DEFAULT_CATEGORIES) {
    try {
      await getPool().execute(
        `INSERT IGNORE INTO categories (category_url, section_label, site, is_active) VALUES (?,?,?,1)`,
        [category_url, section_label, 'dhakapost']);
    } catch (_) {}
  }
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='dhakapost'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) {
    return 1;
  }
}

// â”€â”€ Headline dedup map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HEADLINE_TO_ID = {};

async function loadHeadlineMap() {
  const [rows] = await getPool().execute(
    `SELECT id, actual_headline FROM articles WHERE actual_headline IS NOT NULL AND actual_headline != ''`);
  for (const r of rows) HEADLINE_TO_ID[r.actual_headline] = r.id;
}

// â”€â”€ Image folder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl, articleUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/')) imageUrl = BASE_URL + imageUrl;
    if (imageUrl.startsWith('data:')) return null;

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': randomUA(),
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer':    'https://www.dhakapost.com/',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `dhakapost_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded image: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// â”€â”€ Date helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Parse an ISO 8601 string (with or without timezone) into a naive local
 * datetime string "YYYY-MM-DD HH:MM:SS" so it compares consistently with
 * the last_run_timestamp stored in the JSON file.
 */
function parseIsoToLocalStr(isoStr) {
  if (!isoStr) return null;
  try {
    // Strip timezone offset if present to treat as local time (same as Python's replace(tzinfo=None))
    const cleaned = isoStr.replace(/[+-]\d{2}:\d{2}$/, '').replace('Z', '');
    const d = new Date(cleaned);
    if (isNaN(d)) {
      // Try full parse with timezone then project to local
      const d2 = new Date(isoStr);
      if (isNaN(d2)) return null;
      return `${d2.getFullYear()}-${pad2(d2.getMonth()+1)}-${pad2(d2.getDate())} ${pad2(d2.getHours())}:${pad2(d2.getMinutes())}:${pad2(d2.getSeconds())}`;
    }
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  } catch (_) {
    return null;
  }
}

// â”€â”€ Get article publish datetime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getArticleDateTime(url) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 15000,
      headers: browserHeaders(BASE_URL + '/'),
    }));

    const $ = cheerio.load(resp.data);

    // Method 1: meta[property="article:published_time"]
    const metaDate = $('meta[property="article:published_time"]').attr('content');
    if (metaDate) {
      const parsed = parseIsoToLocalStr(metaDate);
      if (parsed) return parsed;
    }

    // Method 2: JSON-LD datePublished
    let jsonLdDate = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdDate) return;
      try {
        const data = JSON.parse($(el).html() || '{}');
        if (data.datePublished) jsonLdDate = data.datePublished;
        else if (Array.isArray(data['@graph'])) {
          for (const item of data['@graph']) {
            if (item.datePublished) { jsonLdDate = item.datePublished; break; }
          }
        }
      } catch (_) {}
    });
    if (jsonLdDate) {
      const parsed = parseIsoToLocalStr(jsonLdDate);
      if (parsed) return parsed;
    }

    // Method 3: <time datetime="...">
    const timeDt = $('time[datetime]').first().attr('datetime');
    if (timeDt) {
      const parsed = parseIsoToLocalStr(timeDt);
      if (parsed) return parsed;
    }

    return null;
  } catch (e) {
    log(`   [WARN] getArticleDateTime failed for ${url.split('/').pop()}: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// â”€â”€ Sitemap link fetcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetchSitemapArticles(categorySlug, cutoffStr, maxArticles = 200) {
  const sitemapUrl = `${BASE_URL}/${categorySlug}/sitemaps.xml`;
  log(`  Fetching sitemap: ${sitemapUrl}`);

  try {
    const resp = await retryWithBackoff(() => axios.get(sitemapUrl, {
      timeout: 30000,
      headers: { 'User-Agent': randomUA(), 'Accept': 'application/xml, text/xml, */*' },
    }));

    if (resp.status !== 200) {
      log(`  Sitemap fetch failed (HTTP ${resp.status})`);
      return [];
    }

    // Match flat (/economy/123) AND subcategory (/economy/stock-market/123) URLs
    const entryRegex = new RegExp(
      `<url>\\s*<loc>(https://www\\.dhakapost\\.com/${categorySlug}/(?:[^/<]+/)*\\d+)</loc>(?:\\s*<lastmod>([^<]+)</lastmod>)?`,
      'g'
    );

    const entries = [];
    let m;
    while ((m = entryRegex.exec(resp.data)) !== null) {
      entries.push({ url: m[1], lastmod: m[2] || null });
    }

    log(`  Sitemap contains ${entries.length} total articles for /${categorySlug}/`);
    if (!entries.length) return [];

    const newUrls = [];
    let skipped = 0;

    for (const { url, lastmod } of entries) {
      if (cutoffStr && lastmod) {
        try {
          const lastmodStr = parseIsoToLocalStr(lastmod);
          if (lastmodStr && lastmodStr < cutoffStr) {
            skipped++;
            continue;
          }
        } catch (_) {
          // include if parse fails
        }
      }
      newUrls.push(url);
      if (newUrls.length >= maxArticles) break;
    }

    log(`  Sitemap: ${newUrls.length} articles after cutoff, ${skipped} older articles skipped`);
    return newUrls;
  } catch (e) {
    log(`  Error fetching sitemap: ${String(e.message).substring(0, 80)}`);
    return [];
  }
}

// â”€â”€ Main link extraction (two-source hybrid) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates) {
  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();

  const lastTimestamp = lastProcessedDates[sectionLabel];
  let cutoffStr;
  if (!lastTimestamp) {
    const today = new Date();
    cutoffStr = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())} 00:00:00`;
    log(`   No last run timestamp, looking for today's articles: ${cutoffStr.split(' ')[0]}`);
  } else {
    cutoffStr = lastTimestamp;
    log(`   Looking for articles published after: ${cutoffStr}`);
  }

  const allLinks = [];

  // â”€â”€ Source 1: Sitemap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log(`\n  [SITEMAP] Fetching sitemap for /${categorySlug}/ ...`);
  const sitemapLinks = await fetchSitemapArticles(categorySlug, cutoffStr, 200);
  for (const link of sitemapLinks) {
    if (!allLinks.includes(link)) allLinks.push(link);
  }
  log(`  [SITEMAP] ${sitemapLinks.length} articles newer than cutoff`);

  // â”€â”€ Source 2: HTML page scrape â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log(`  [HTML] Fetching category page...`);
  const pageLinks = [];
  try {
    // Warm-up request to get session cookies
    await axios.get(BASE_URL, { timeout: 15000, headers: browserHeaders() }).catch(() => {});
    await sleep(500);

    const resp = await axios.get(categoryUrl, {
      timeout: 15000,
      headers: browserHeaders(BASE_URL + '/'),
    });

    if (resp.status === 200) {
      const html = resp.data;

      // Detect Cloudflare challenge
      if (html.includes('challenge-platform') || html.includes('Just a moment')) {
        log(`  âš ï¸  Cloudflare challenge detected on category page â€” sitemap results will be used`);
      } else {
        // Match full href paths: /economy/123 AND /economy/subcategory/123
        // Require path to end with a 5+ digit numeric article ID
        const hrefPattern = new RegExp(
          `href="(/${categorySlug}/(?:[a-z0-9-]+/)*(\\d{5,}))"`, 'g'
        );
        const seenUrls = new Set();
        let mm;
        while ((mm = hrefPattern.exec(html)) !== null) {
          const fullUrl = `${BASE_URL}${mm[1]}`;
          if (!seenUrls.has(fullUrl)) {
            seenUrls.add(fullUrl);
            pageLinks.push(fullUrl);
            if (!allLinks.includes(fullUrl)) allLinks.push(fullUrl);
          }
        }
      }
    } else {
      log(`  âš ï¸  Failed to fetch page (HTTP ${resp.status})`);
    }
  } catch (e) {
    log(`  âš ï¸  Error fetching page: ${String(e.message).substring(0, 80)}`);
  }

  log(`  [HTML] ${pageLinks.length} articles from page (${allLinks.length} total combined)`);
  return allLinks;
}

// â”€â”€ Article scraping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeArticle(url) {
  try {
    await sleep(500);

    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent':                randomUA(),
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9,bn;q=0.8',
        'Sec-Ch-Ua':                 '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile':          '?0',
        'Sec-Ch-Ua-Platform':        '"Windows"',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    }));

    const $ = cheerio.load(resp.data);

    // Headline
    const headline = $('h1').first().text().trim() || null;

    // Date
    const publishedDate = await getArticleDateTime(url);
    const isoDate = publishedDate || nowStr();

    // Content
    let content = null;
    const newsDetailsDiv = $('div').filter((_, el) => {
      const cls = $(el).attr('class') || '';
      return cls.includes('news-details');
    }).first();

    if (newsDetailsDiv.length) {
      const parts = [];
      newsDetailsDiv.find('p').each((_, el) => {
        const txt = $(el).text().trim();
        if (txt) parts.push(txt);
      });
      content = parts.join(' ') || null;
    }

    if (!content) {
      // Fallback: main or article tag
      const container = $('main').first().length ? $('main').first() : $('article').first();
      if (container.length) {
        const parts = [];
        container.find('p').each((_, el) => {
          const txt = $(el).text().trim();
          if (txt) parts.push(txt);
        });
        content = parts.join(' ') || null;
      }
    }

    // Image â€“ prefer cdn.dhakapost.com/media/imgAll URLs
    const CDN_PATH = 'cdn.dhakapost.com/media/imgAll';
    let imageUrl = null;

    // Method 1: <link rel="preload" as="image" href="...">
    $('link[rel="preload"][as="image"]').each((_, el) => {
      if (imageUrl) return;
      const href = $(el).attr('href') || '';
      if (href.includes(CDN_PATH)) imageUrl = href;
    });

    // Method 2: <img class*="w-full"> with CDN src
    if (!imageUrl) {
      $('img').filter((_, el) => {
        const cls = $(el).attr('class') || '';
        return cls.includes('w-full');
      }).each((_, el) => {
        if (imageUrl) return;
        const src = $(el).attr('src') || '';
        if (src.includes(CDN_PATH) && !src.startsWith('data:')) imageUrl = src;
      });
    }

    // Method 3: JSON-LD image field
    if (!imageUrl) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (imageUrl) return;
        try {
          const data = JSON.parse($(el).html() || '{}');
          const imgObj = data.image;
          let imgRaw = null;
          if (typeof imgObj === 'object' && imgObj) imgRaw = imgObj.url || null;
          else if (typeof imgObj === 'string') imgRaw = imgObj;
          if (imgRaw && imgRaw.includes(CDN_PATH)) imageUrl = imgRaw;
        } catch (_) {}
      });
    }

    // Method 4: og:image (only CDN imgAll)
    if (!imageUrl) {
      const ogImg = $('meta[property="og:image"]').attr('content') || '';
      if (ogImg.includes(CDN_PATH)) {
        imageUrl = ogImg.includes('?') ? ogImg.split('?')[0] : ogImg;
      }
    }

    // Tags
    const tagsSet = new Set();
    $('meta[property="article:tag"]').each((_, el) => {
      const content = $(el).attr('content') || '';
      content.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tagsSet.add(t));
    });
    if (!tagsSet.size) {
      $('a[href*="/topic/"]').each((_, el) => {
        const txt = $(el).text().trim();
        if (txt) tagsSet.add(txt);
      });
    }
    const tags = tagsSet.size ? Array.from(tagsSet).join(', ') : 'Not Available';

    if (!headline || !content) {
      const articleId = url.split('/').pop();
      log(`   [WARN] Missing headline or content for article ${articleId}`);
      log(`     Headline: ${!!headline}, Content: ${!!content}`);
      return null;
    }

    const imageName = imageUrl ? await downloadImage(imageUrl, url) : null;

    log(`   Scraped: headline=${headline.length} chars, content=${content.length} chars, tags=${tags.substring(0, 50)}`);
    return { headline, isoDate, content, imageName, tags };
  } catch (e) {
    const articleId = url.split('/').pop();
    log(`   [ERROR] scrapeArticle(${articleId}): ${String(e.message).substring(0, 100)}`);
    return null;
  }
}

// â”€â”€ Category ID resolver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getCategoryId(sectionLabel) {
  const key = sectionLabel.replace(/^dhakapost-/, '');
  return SECTION_TO_CATEGORY_ID[key] || 7;
}

// â”€â”€ Process a single URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    const { headline, isoDate, content, imageName, tags } = articleData;
    const catId = getCategoryId(sectionLabel);

    const existingId = HEADLINE_TO_ID[headline];
    if (existingId) {
      await updateArticleSuccess(existingId, {
        headline, isoDate, content: content || '', imageName, tags, category: catId, section: sectionLabel,
      });
      log(`   [OK] Updated existing article (id ${existingId})`);
    } else {
      try {
        const newId = await insertArticle({
          headline, isoDate, content: content || '', imageName, url, tags, category: catId, section: sectionLabel,
        });
        if (newId) {
          HEADLINE_TO_ID[headline] = newId;
          log(`   [OK] Inserted new article (id ${newId})`);
        } else {
          log(`   [ERROR] Insert returned null`);
          return false;
        }
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          log(`   Article already exists in DB (duplicate URL)`);
        } else {
          throw e;
        }
      }
    }

    return true;
  } catch (e) {
    log(`   [ERROR] processArticle: ${String(e.message).substring(0, 100)}`);
    try { await insertFailedUrl(url, sectionLabel, String(e.message)); } catch (_) {}
    return false;
  }
}

// â”€â”€ Main loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('DHAKAPOST.COM NEWS SCRAPER - MySQL Version');
  log('='.repeat(70));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

  ensureImgFolder();

  try { await ensureDefaultCategories(); log('Default categories initialized'); }
  catch (e) { log(`[WARNING] Could not initialize default categories: ${e.message}`); }

  try { await loadHeadlineMap(); }
  catch (e) { log(`[WARNING] Could not load headline map: ${e.message}`); }

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
      log('No active Dhaka Post categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Dhaka Post categories`);

    // Retry failed articles
    log('\n--- Checking for failed URLs to retry (max 10 attempts) ---');
    log('[STATUS:finding:Checking for failed articles]');
    try {
      const failedRows = await getFailedArticles(10);
      log(`Found ${failedRows.length} failed URLs to retry`);
      for (let i = 0; i < failedRows.length; i++) {
        const row     = failedRows[i];
        const url     = row.source_url;
        if (!url) continue;
        const section = row.section || 'dhakapost-politics';
        const attempt = (row.processing_count || 0) + 1;
        log(`\n[${i+1}/${failedRows.length}] Retrying URL (attempt ${attempt}/10): ${url}`);
        const ok = await processArticle(url, section, row);
        log(ok ? `âœ… Retry succeeded => ${url}` : `âŒ Retry still failing => ${url}`);
        await sleep(2000);
      }
    } catch (e) {
      log(`[WARNING] Error retrying failed articles: ${e.message}`);
    }

    const cycleStart = Date.now();

    log(`\n${'='.repeat(70)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(70) + '\n');

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      log(`\n${'='.repeat(70)}`);
      log(`Processing: ${sectionLabel}`);
      log(`URL: ${categoryUrl}`);
      log('='.repeat(70));

      const lastTimestamp = lastProcessedDates[sectionLabel];
      if (lastTimestamp) {
        log(`Last Run: ${lastTimestamp}`);
      } else {
        log(`Last Run: Never (First time)`);
      }

      // Capture start time before extraction (prevents missing articles published during cycle)
      const cycleSectionStart = nowStr();

      log(`[STATUS:finding:Searching ${sectionLabel}]`);
      const articleLinks = await extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates);

      const newLinks = [];
      for (const u of articleLinks) {
        if (!(await urlExists(u))) newLinks.push(u);
      }
      log(`Found ${articleLinks.length} total links (${newLinks.length} new, ${articleLinks.length - newLinks.length} already in DB)`);

      if (!newLinks.length) {
        log(`No new articles for ${sectionLabel}`);
        lastProcessedDates[sectionLabel] = cycleSectionStart;
        saveLastProcessedDates(lastProcessedDates);
        await sleep(2000);
        continue;
      }

      // Article-level date guard
      let cutoffStr = null;
      if (lastTimestamp) cutoffStr = lastTimestamp;

      log(`\n[SCRAPING] Processing ${newLinks.length} new articles...`);

      for (let idx = 0; idx < newLinks.length; idx++) {
        const u = newLinks[idx];
        log(`[STATUS:extracting:${idx+1}/${newLinks.length}]`);
        log(`\n[${idx+1}/${newLinks.length}] ${u}`);

        // Date guard
        if (cutoffStr) {
          const articleDt = await getArticleDateTime(u);
          if (articleDt) {
            if (articleDt < cutoffStr) {
              log(`   [SKIP] Article published ${articleDt} is older than last run ${cutoffStr}`);
              continue;
            } else {
              log(`   [DATE OK] Published ${articleDt}`);
            }
          } else {
            log(`   [DATE UNKNOWN] Could not extract publish date, processing anyway`);
          }
        }

        try {
          const ok = await processArticle(u, sectionLabel);
          log(ok ? `âœ“ Processed => ${u}` : `âœ— Failed => ${u}`);
          await sleep(2000);
        } catch (e) {
          log(`   [ERROR] ${String(e.message).substring(0, 100)}`);
        }
      }

      lastProcessedDates[sectionLabel] = cycleSectionStart;
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
      log(`\nCycle took ${cycleDuration}s (longer than ${CYCLE_TIME}s cycle time). Starting next immediately...\n`);
    }
  }

  if (pool) await pool.end();
}

main().catch(e => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
