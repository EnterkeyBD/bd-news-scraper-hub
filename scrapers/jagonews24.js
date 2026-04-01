#!/usr/bin/env node
'use strict';

/**
 * Jagonews24 Scraper – Node.js
 * Ported from jagonews24-scraper/scrapjagonews24_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active jagonews24 categories from MySQL
 *  - Two-source link extraction with per-article date filtering:
 *      1. Category HTML page  — hrefs matching /{slug}/{sub}/\d+
 *      2. AJAX load-more      — GET /load-more-category-content?page=N&catType=1&catid=CATID
 *         Pagination stops as soon as an article older than the cutoff is found
 *  - Date extraction per article (fetched during link discovery to gate pagination):
 *      span.time-with-author "প্রকাশিত: ..." → Bengali AM/PM datetime
 *      → div.col-sm-8 text   → JSON-LD datePublished → meta[property="article:published_time"]
 *  - Article scraping:
 *      headline:  <h1> → <h2>
 *      date:      same 4-method chain as above (article page already fetched)
 *      content:   div.content-details paragraphs; fallback full text; fallback article/main
 *      image:     JSON-LD image with imgAllNew/BG/ path (clean, no watermark)
 *                 → featured/figure container img → og:image (imgAllNew/ only, not og-image/)
 *                 → content-div img with cdn.jagonews24.com
 *      tags:      svg.details-tags-icon parent → a[href*="/topic/"]
 *                 → fallback any /topic/ links
 *  - Retries failed articles each cycle (max 10 attempts)
 *  - Exponential back-off on HTTP 408/429/5xx and network errors (3 attempts)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// ── Paths ───────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'jagonews24.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'jagonews24');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600;

// ── DB Config ───────────────────────────────────────────────────────────────
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

// ── Site config ─────────────────────────────────────────────────────────────
const BASE_URL    = 'https://www.jagonews24.com';
const BASE_DOMAIN = 'www.jagonews24.com';

const SECTION_TO_CATEGORY_ID = {
  national:      5,
  politics:      10,
  economy:       9,
  international: 6,
  sports:        8,
  entertainment: 14,
  country:       11,
  capital:       12,
  crime:         13,
  education:     17,
  tech:          15,
  lifestyle:     16,
  opinion:       18,
};

// AJAX catid mapping for load-more-category-content endpoint
const SLUG_TO_CAT_ID = {
  economy:       3,
  national:      1,
  politics:      2,
  international: 4,
  sports:        6,
  entertainment: 7,
  country:       5,
  crime:         8,
  education:     9,
  tech:          10,
  lifestyle:     11,
  opinion:       12,
};

const DEFAULT_CATEGORIES = [
  { category_url: 'https://www.jagonews24.com/national',      section_label: 'jagonews24-national'      },
  { category_url: 'https://www.jagonews24.com/politics',      section_label: 'jagonews24-politics'      },
  { category_url: 'https://www.jagonews24.com/economy',       section_label: 'jagonews24-economy'       },
  { category_url: 'https://www.jagonews24.com/international', section_label: 'jagonews24-international' },
  { category_url: 'https://www.jagonews24.com/sports',        section_label: 'jagonews24-sports'        },
  { category_url: 'https://www.jagonews24.com/entertainment', section_label: 'jagonews24-entertainment' },
  { category_url: 'https://www.jagonews24.com/country',       section_label: 'jagonews24-country'       },
];

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// ── Tiny helpers ─────────────────────────────────────────────────────────────
function log(msg)   { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)    { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function randomUA() {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ];
  return UAS[Math.floor(Math.random() * UAS.length)];
}

// ── Retry with exponential backoff ───────────────────────────────────────────
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
      log(`   [RETRY] Attempt ${attempt+1}/${maxAttempts} after ${delay/1000}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Browser-like headers ─────────────────────────────────────────────────────
function browserHeaders(referer) {
  return {
    'User-Agent':                randomUA(),
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':           'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':           'gzip, deflate',
    'Connection':                'keep-alive',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua':                 '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile':          '?0',
    'sec-ch-ua-platform':        '"Windows"',
    ...(referer ? { 'Referer': referer } : {}),
  };
}

// ── Cycle time ───────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['jagonews24'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// ── Last-processed dates ─────────────────────────────────────────────────────
function loadLastProcessedDates() {
  try {
    if (fs.existsSync(LAST_PROC_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_PROC_FILE, 'utf8'));
      // Migrate old dict format: {"section": {"timestamp": "..."}} → {"section": "..."}
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object') data[k] = v.timestamp || null;
      }
      return data;
    }
  } catch (_) {}
  return {};
}

function saveLastProcessedDates(data) {
  fs.writeFileSync(LAST_PROC_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── DB pool ──────────────────────────────────────────────────────────────────
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// ── DB helpers ───────────────────────────────────────────────────────────────
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
  if (isoDate && isoDate !== 'Not Available') {
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
  if (isoDate && isoDate !== 'Not Available') {
    try { pubDt = new Date(isoDate); if (isNaN(pubDt)) pubDt = null; } catch (_) {}
  }
  await getPool().execute(
    `UPDATE articles
        SET headline=?, actual_headline=?, published_at=?, content=?,
            image_name=?, source_site=?, tags=?, category=?, section=?,
            scraping_status='Success', processing_count=processing_count+1
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
    `SELECT category_url, section_label FROM categories WHERE site='jagonews24' AND is_active=1`);
  return rows;
}

async function ensureDefaultCategories() {
  for (const { category_url, section_label } of DEFAULT_CATEGORIES) {
    try {
      await getPool().execute(
        `INSERT IGNORE INTO categories (category_url, section_label, site, is_active) VALUES (?,?,?,1)`,
        [category_url, section_label, 'jagonews24']);
    } catch (_) {}
  }
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='jagonews24'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) { return 1; }
}

// ── Headline dedup map ───────────────────────────────────────────────────────
const HEADLINE_TO_ID = {};

async function loadHeadlineMap() {
  const [rows] = await getPool().execute(
    `SELECT id, actual_headline FROM articles WHERE actual_headline IS NOT NULL AND actual_headline != ''`);
  for (const r of rows) HEADLINE_TO_ID[r.actual_headline] = r.id;
}

// ── Image folder ─────────────────────────────────────────────────────────────
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/')) imageUrl = BASE_URL + imageUrl;
    if (imageUrl.startsWith('data:')) return null;

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent':    randomUA(),
        'Accept':        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer':       'https://www.jagonews24.com/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `jagonews24_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded image: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// ── Bengali date parser ──────────────────────────────────────────────────────
const BN_MONTHS = {
  'জানুয়ারি': 'January', 'ফেব্রুয়ারি': 'February', 'মার্চ': 'March',
  'এপ্রিল':   'April',   'মে':         'May',       'জুন':   'June',
  'জুলাই':    'July',    'আগস্ট':      'August',    'সেপ্টেম্বর': 'September',
  'অক্টোবর':  'October', 'নভেম্বর':   'November',  'ডিসেম্বর': 'December',
};

const BN_DIGITS = str => str.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));

/**
 * Convert Bengali datetime string like "০৮:৫২ এএম, ০১ ফেব্রুয়ারি ২০২৬"
 * to "YYYY-MM-DDTHH:MM:SS"
 */
function convertBengaliDate(raw) {
  if (!raw) return null;
  try {
    let s = BN_DIGITS(raw.trim());

    // Detect and strip AM/PM markers
    let isPm = false;
    if (s.includes('পিএম') || s.includes('PM')) { isPm = true; s = s.replace(/পিএম|PM/g, '').trim(); }
    else if (s.includes('এএম') || s.includes('AM')) { s = s.replace(/এএম|AM/g, '').trim(); }

    // Replace Bengali month names
    for (const [bn, en] of Object.entries(BN_MONTHS)) {
      if (s.includes(bn)) { s = s.replace(bn, en); break; }
    }

    // Clean commas and extra spaces
    s = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

    let d;
    // Format: "HH:MM DD Month YYYY" (time first)
    if (/^\d{1,2}:\d{2}/.test(s)) {
      const parts = s.split(' ');
      const timePart = parts[0];
      const datePart = parts.slice(1).join(' ');
      d = new Date(`${datePart} ${timePart}`);
    } else {
      // Format: "DD Month YYYY HH:MM"
      d = new Date(s);
    }

    if (isNaN(d)) return null;

    // Apply 12-hr AM/PM adjustment
    let h = d.getHours();
    if (isPm && h !== 12) h += 12;
    else if (!isPm && h === 12) h = 0;
    d.setHours(h);

    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  } catch (_) {
    return null;
  }
}

// ── Extract publish date from already-loaded cheerio $ ───────────────────────
function extractDateFromCheerio($) {
  // Method 1: span.time-with-author "প্রকাশিত: ..."
  const timeSpan = $('span.time-with-author');
  if (timeSpan.length) {
    const spanText = timeSpan.text();
    const m = spanText.match(/প্রকাশিত:\s*(.+?)(?:\n|আপডেট|$)/);
    if (m) {
      const r = convertBengaliDate(m[1].trim());
      if (r) return r;
    }
  }

  // Method 2: div.col-sm-8 text
  const col = $('.col-sm-8');
  if (col.length) {
    const m = col.text().match(/প্রকাশিত:\s*(.+?)(?:\n|আপডেট|$)/);
    if (m) {
      const r = convertBengaliDate(m[1].trim());
      if (r) return r;
    }
  }

  // Method 3: JSON-LD datePublished
  let jsonLdDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdDate) return;
    try {
      let data = JSON.parse($(el).html() || '{}');
      if (Array.isArray(data)) {
        data = data.find(i => i && i.datePublished) || {};
      }
      if (data['@graph']) {
        const item = data['@graph'].find(i => i && i.datePublished);
        if (item) data = item;
      }
      if (data.datePublished) jsonLdDate = data.datePublished;
    } catch (_) {}
  });
  if (jsonLdDate) {
    try {
      const d = new Date(jsonLdDate.replace('Z', '+00:00'));
      if (!isNaN(d)) {
        return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }
    } catch (_) {}
    return convertBengaliDate(jsonLdDate);
  }

  // Method 4: meta article:published_time
  const metaDate = $('meta[property="article:published_time"]').attr('content');
  if (metaDate) {
    try {
      const d = new Date(metaDate.replace('Z', '+00:00'));
      if (!isNaN(d)) {
        return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }
    } catch (_) {}
  }

  return null;
}

// ── Fetch & parse article – returns {$, html} or null ────────────────────────
async function fetchArticlePage(url) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 20000,
      headers: browserHeaders(BASE_URL + '/'),
    }));
    if (resp.status !== 200) return null;
    return resp.data;
  } catch (_) {
    return null;
  }
}

// ── Extract article links from HTML (both page and AJAX responses) ───────────
function extractLinksFromHtml(html, categorySlug) {
  const $ = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  // Match /{slug}/{sub}/\d+ (e.g. /sports/cricket/12345, /national/news/12345)
  const linkPattern = new RegExp(`^(?:${BASE_URL})?/(${categorySlug}/[a-z-]+/\\d+)$`);

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    // Normalise
    if (href.startsWith(`${BASE_URL}/`)) href = href.slice(BASE_URL.length);
    const m = href.match(linkPattern) || href.match(new RegExp(`/(${categorySlug}/[a-z-]+/\\d+)$`));
    if (!m) return;
    const fullUrl = `${BASE_URL}/${m[1]}`;
    if (!seen.has(fullUrl)) { seen.add(fullUrl); links.push(fullUrl); }
  });

  return links;
}

// ── AJAX load-more fetch ──────────────────────────────────────────────────────
async function fetchAjaxPage(categorySlug, page, catId) {
  try {
    const resp = await retryWithBackoff(() => axios.get(
      `${BASE_URL}/load-more-category-content`,
      {
        timeout: 15000,
        params: { page, catType: '1', catid: String(catId) },
        headers: {
          'User-Agent':        randomUA(),
          'Accept':            '*/*',
          'Accept-Language':   'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
          'X-Requested-With':  'XMLHttpRequest',
          'Referer':           `${BASE_URL}/${categorySlug}`,
          'Sec-Fetch-Dest':    'empty',
          'Sec-Fetch-Mode':    'cors',
          'Sec-Fetch-Site':    'same-origin',
          'sec-ch-ua':         '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile':  '?0',
          'sec-ch-ua-platform': '"Windows"',
        },
      }
    ));
    if (resp.status !== 200) return [];
    return extractLinksFromHtml(resp.data, categorySlug);
  } catch (e) {
    log(`   [WARN] AJAX fetch page ${page} failed: ${String(e.message).substring(0, 60)}`);
    return [];
  }
}

// ── Main link extraction ──────────────────────────────────────────────────────
/**
 * Fetches article links and filters by publish date.
 * Returns array of {url, isoDate, html} — html is the already-fetched article
 * page so scrapeArticle() can reuse it without a second HTTP request.
 *
 * Pagination stops when any article older than cutoff is found (like ittefaq).
 */
async function extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates, maxPages = 5) {
  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();

  const lastTimestamp = lastProcessedDates[sectionLabel];
  let cutoffStr;
  if (!lastTimestamp) {
    const today = new Date();
    cutoffStr = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}T00:00:00`;
    log(`   No last run timestamp, collecting today's articles only`);
  } else {
    // Convert "YYYY-MM-DD HH:MM:SS" → ISO for comparison with extracted dates
    cutoffStr = lastTimestamp.replace(' ', 'T');
    log(`   Looking for articles published after: ${lastTimestamp}`);
  }

  const allEntries    = [];   // {url, isoDate, html}
  const seenUrls      = new Set();
  let foundOldArticle = false;

  // ── Source 1: initial HTML category page ─────────────────────────────────
  log(`   Fetching category page: ${categoryUrl}`);
  try {
    const resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 15000,
      headers: browserHeaders(),
    }));
    if (resp.status === 200) {
      const pageLinks = extractLinksFromHtml(resp.data, categorySlug);
      log(`   Found ${pageLinks.length} link(s) on category page`);

      for (const url of pageLinks) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        const html = await fetchArticlePage(url);
        if (!html) { allEntries.push({ url, isoDate: null, html: null }); continue; }

        const $ = cheerio.load(html);
        const isoDate = extractDateFromCheerio($);

        if (isoDate && cutoffStr && isoDate < cutoffStr) {
          log(`   [SKIP] Old article: ${isoDate} (${url.split('/').pop()})`);
          foundOldArticle = true;
          // Don't break here – process all links from the initial page
        } else {
          if (isoDate) log(`   [+] ${isoDate} => ${url.split('/').pop()}`);
          allEntries.push({ url, isoDate, html });
        }

        await sleep(100);
      }
    }
  } catch (e) {
    log(`   [WARN] Category page fetch failed: ${String(e.message).substring(0, 80)}`);
  }

  // ── Source 2: AJAX load-more pages ───────────────────────────────────────
  const catId = SLUG_TO_CAT_ID[categorySlug] || 1;

  for (let page = 2; page <= maxPages && !foundOldArticle; page++) {
    log(`   [AJAX] Fetching page ${page} (catid=${catId})...`);
    const ajaxLinks = await fetchAjaxPage(categorySlug, page, catId);

    if (!ajaxLinks.length) {
      log(`   [AJAX] No links on page ${page}, stopping`);
      break;
    }

    let newOnPage = 0;
    for (const url of ajaxLinks) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const html = await fetchArticlePage(url);
      if (!html) { allEntries.push({ url, isoDate: null, html: null }); continue; }

      const $ = cheerio.load(html);
      const isoDate = extractDateFromCheerio($);

      if (isoDate && cutoffStr && isoDate < cutoffStr) {
        log(`   [STOP] Old article on AJAX page ${page}: ${isoDate} => stopping pagination`);
        foundOldArticle = true;
        break;
      }

      if (isoDate) log(`   [+] ${isoDate} => ${url.split('/').pop()}`);
      allEntries.push({ url, isoDate, html });
      newOnPage++;
      await sleep(100);
    }

    if (newOnPage === 0 && !foundOldArticle) break;
    await sleep(300);
  }

  log(`   Found total of ${allEntries.length} articles to process`);
  return allEntries;
}

// ── Validate image URL ────────────────────────────────────────────────────────
function isValidArticleImage(url) {
  if (!url || url.startsWith('data:') || url.length < 20) return false;
  const lower = url.toLowerCase();
  return !['logo', 'icon', 'avatar', 'sprite', 'banner', 'ad-', 'advertisement']
    .some(p => lower.includes(p));
}

// ── Article scraping (uses pre-fetched HTML) ──────────────────────────────────
async function scrapeArticle(url, preloadedHtml) {
  try {
    const html = preloadedHtml || await fetchArticlePage(url);
    if (!html) return null;

    const $ = cheerio.load(html);

    // Headline
    const headline = $('h1').first().text().trim() || $('h2').first().text().trim() || null;

    // Date (from pre-loaded page)
    const isoDate = extractDateFromCheerio($) || 'Not Available';

    // Content
    let content = null;
    const contentDiv = $('div.content-details').first();
    if (contentDiv.length) {
      const parts = [];
      contentDiv.find('p').each((_, el) => {
        const t = $(el).text().trim();
        if (t) parts.push(t);
      });
      content = parts.length ? parts.join(' ') : contentDiv.text().replace(/\s+/g, ' ').trim() || null;
    }
    if (!content) {
      const container = $('article').first().length ? $('article').first() : $('main').first();
      if (container.length) {
        const parts = [];
        container.find('p').each((_, el) => {
          const t = $(el).text().trim();
          if (t) parts.push(t);
        });
        content = parts.join(' ') || null;
      }
    }

    // Image — prefer cdn.jagonews24.com/imgAllNew/BG/ (clean, no watermark)
    let imageUrl = null;

    // Method 1: JSON-LD image with imgAllNew/BG/ path
    $('script[type="application/ld+json"]').each((_, el) => {
      if (imageUrl) return;
      try {
        let data = JSON.parse($(el).html() || '{}');
        if (Array.isArray(data)) data = data.find(i => i && i.image) || {};
        const imgObj = data.image;
        let raw = null;
        if (typeof imgObj === 'object' && imgObj) raw = imgObj.url || null;
        else if (typeof imgObj === 'string') raw = imgObj;
        if (!raw || !isValidArticleImage(raw)) return;
        if (raw.includes('imgAllNew/BG/')) { imageUrl = raw; return; }
        if (raw.includes('cdn.jagonews24.com') && !raw.includes('/og-image/')) imageUrl = raw;
      } catch (_) {}
    });

    // Method 2: Featured/figure container img with CDN URL
    if (!imageUrl) {
      const containers = [
        $('div[class*="featured"]'), $('div[class*="main-image"]'), $('div[class*="article-image"]'),
        $('div[class*="news-image"]'), $('div[class*="thumb"]'), $('figure'),
        $('div[class*="photo"]'), $('div[class*="picture"]'), $('div[class*="img-container"]'),
      ];
      for (const c of containers) {
        if (imageUrl) break;
        if (!c.length) continue;
        const img = c.first().find('img').first();
        const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src');
        if (src && isValidArticleImage(src) && src.includes('cdn.jagonews24.com')) imageUrl = src;
      }
    }

    // Method 3: og:image only if from imgAllNew/ (not og-image/ folder)
    if (!imageUrl) {
      const ogImg = $('meta[property="og:image"]').attr('content') || '';
      if (ogImg.includes('imgAllNew/') && !ogImg.includes('/og-image/') && isValidArticleImage(ogImg)) {
        imageUrl = ogImg;
      }
    }

    // Method 4: content-div img with CDN URL
    if (!imageUrl && contentDiv.length) {
      contentDiv.find('img').each((_, el) => {
        if (imageUrl) return;
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src.includes('cdn.jagonews24.com') && isValidArticleImage(src)) imageUrl = src;
      });
    }

    // Tags — from details-tags-icon parent, then fallback any /topic/ links
    const tagSet = new Set();
    const tagsIcon = $('svg.details-tags-icon');
    if (tagsIcon.length) {
      const container = tagsIcon.closest('ul').length ? tagsIcon.closest('ul') : tagsIcon.closest('div');
      container.find('a[href*="/topic/"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t) tagSet.add(t);
      });
    }
    if (!tagSet.size) {
      $('a[href*="/topic/"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t) tagSet.add(t);
      });
    }
    const tags = tagSet.size ? Array.from(tagSet).join(', ') : 'Not Available';

    if (!headline || !content) {
      log(`   [WARN] Missing headline or content for ${url.split('/').pop()}`);
      return null;
    }

    const imageName = imageUrl ? await downloadImage(imageUrl) : null;

    log(`   Scraped: headline=${headline.length} chars, content=${content.length} chars`);
    return { headline, isoDate, content, imageName, tags };
  } catch (e) {
    log(`   [ERROR] scrapeArticle(${url.split('/').pop()}): ${String(e.message).substring(0, 100)}`);
    return null;
  }
}

// ── Category ID resolver ──────────────────────────────────────────────────────
function getCategoryId(sectionLabel) {
  const key = sectionLabel.replace(/^jagonews24-/, '');
  return SECTION_TO_CATEGORY_ID[key] || 7;
}

// ── Process a single URL ──────────────────────────────────────────────────────
async function processArticle(url, sectionLabel, preloadedHtml, existingRow) {
  try {
    existingRow = existingRow || await getArticleByUrl(url);
    if (existingRow) {
      const status = existingRow.scraping_status;
      const count  = existingRow.processing_count || 0;
      const pubAt  = existingRow.published_at;
      if (status === 'Success' && pubAt !== null) {
        log(`   [SKIP] Already processed (success): ${url}`);
        return true;
      }
      if (status === 'Failed' && count >= 10) {
        log(`   [SKIP] Max retries reached (${count}/10): ${url}`);
        return false;
      }
    }

    const articleData = await scrapeArticle(url, preloadedHtml);
    if (!articleData || !articleData.headline) {
      log(`   [ERROR] Failed to scrape content`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Failed to scrape content');
      else await insertFailedUrl(url, sectionLabel, 'Failed to scrape content');
      return false;
    }

    const { headline, isoDate, content, imageName, tags } = articleData;
    const catId = getCategoryId(sectionLabel);

    // Check for existing by headline OR by existing row ID
    const existingId = (existingRow && existingRow.id) || HEADLINE_TO_ID[headline];

    if (existingId) {
      await updateArticleSuccess(existingId, {
        headline, isoDate, content: content || '', imageName, tags, category: catId, section: sectionLabel,
      });
      log(`   [OK] Updated article (id ${existingId})`);
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
        } else { throw e; }
      }
    }

    return true;
  } catch (e) {
    log(`   [ERROR] processArticle: ${String(e.message).substring(0, 100)}`);
    try { await insertFailedUrl(url, sectionLabel, String(e.message)); } catch (_) {}
    return false;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('JAGONEWS24.COM NEWS SCRAPER - MySQL Version');
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
      log('No active Jagonews24 categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Jagonews24 categories`);

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
        const section = row.section || 'jagonews24-national';
        const attempt = (row.processing_count || 0) + 1;
        log(`\n[${i+1}/${failedRows.length}] Retrying (attempt ${attempt}/10): ${url}`);
        const ok = await processArticle(url, section, null, row);
        log(ok ? `✅ Retry succeeded` : `❌ Retry still failing`);
        await sleep(500);
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
      log(lastTimestamp ? `Last Run: ${lastTimestamp}` : `Last Run: Never (First time)`);

      // Capture timestamp BEFORE extraction (prevents missing articles published during cycle)
      const cycleSectionStart = nowStr();

      log(`[STATUS:finding:Searching ${sectionLabel}]`);
      const articleEntries = await extractNewsLinks(categoryUrl, sectionLabel, lastProcessedDates);

      // Filter out already-in-DB URLs
      const newEntries = [];
      for (const entry of articleEntries) {
        if (!(await urlExists(entry.url))) newEntries.push(entry);
      }
      log(`Found ${articleEntries.length} total links (${newEntries.length} new, ${articleEntries.length - newEntries.length} already in DB)`);

      if (!newEntries.length) {
        log(`No new articles for ${sectionLabel}`);
        lastProcessedDates[sectionLabel] = cycleSectionStart;
        saveLastProcessedDates(lastProcessedDates);
        await sleep(500);
        continue;
      }

      log(`\n[SCRAPING] Processing ${newEntries.length} new articles...`);

      for (let idx = 0; idx < newEntries.length; idx++) {
        const { url, isoDate, html } = newEntries[idx];
        log(`[STATUS:extracting:${idx+1}/${newEntries.length}]`);
        log(`\n[${idx+1}/${newEntries.length}] ${url}`);

        try {
          const ok = await processArticle(url, sectionLabel, html);
          log(ok ? `✓ Processed => ${url}` : `✗ Failed => ${url}`);
          await sleep(500);
        } catch (e) {
          log(`   [ERROR] ${String(e.message).substring(0, 100)}`);
        }
      }

      lastProcessedDates[sectionLabel] = cycleSectionStart;
      saveLastProcessedDates(lastProcessedDates);
      log(`Completed processing for ${sectionLabel}`);
      await sleep(500);
    }

    const cycleDuration = Math.floor((Date.now() - cycleStart) / 1000);

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
