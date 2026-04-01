#!/usr/bin/env node
'use strict';

/**
 * Mzamin Scraper - Node.js
 * Ported from mzamin-scraper/scrapmzamin_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Architecture:
 *  - Category pages paginated as {category_url}/{page_num} (up to 10 pages)
 *  - Article links: /article/{id}/{slug} â€” sorted by ID desc (newer first)
 *  - Date: meta[property="article:published_time"] content="YYYY-MM-DD HH:MM:SS" (space, not T)
 *  - Cutoff: article_dt < cutoff_dt (strictly less than â€” equal is still new)
 *  - Stops after 3 consecutive old articles per page; stops paginating after threshold hit
 *  - Content: div.prose -> <p> tags; fallback: all <p> tags with >20 chars
 *  - Image priority:
 *      1. div.overflow-hidden.rounded-t-lg img[src with /uploads/news/]
 *      2. img.w-full.h-auto[src with /uploads/news/]
 *      3. og:image (if contains /uploads/news/)
 *  - Image filename: mzamin_{8-char random hex}.jpg
 *  - No pagination on first run (today-only mode)
 *  - Reads cycle time from scraper_cycle_config.json (default 600s)
 *  - Emits [STATUS:...] tokens parsed by server.js
 *  - Emits [OK] Inserted new article (ID: X) for server.js article counting
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// -- Paths -------------------------------------------------------------------
const PROJ_ROOT      = path.resolve(__dirname, '..', '..');
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'mzamin.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'mzamin');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600;

// -- DB Config ---------------------------------------------------------------
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

// -- Site config -------------------------------------------------------------
const BASE_URL        = 'https://www.mzamin.com';
const BASE_DOMAIN     = 'mzamin';
const UPLOADS_PATH    = '/uploads/news/';
const MAX_PAGES       = 10;
const CONSEC_OLD_STOP = 3;  // stop after this many consecutive old articles

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// -- Tiny helpers ------------------------------------------------------------
function log(msg)  { process.stdout.write(String(msg) + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)   { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function randomHex8() {
  return crypto.randomBytes(4).toString('hex');
}

// -- Retry with exponential back-off -----------------------------------------
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

function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

// -- Cycle time --------------------------------------------------------------
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['mzamin'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// -- Last-processed dates ----------------------------------------------------
function loadLastProcessedDates() {
  try {
    if (fs.existsSync(LAST_PROC_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_PROC_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveLastProcessedDates(data) {
  fs.writeFileSync(LAST_PROC_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// -- DB pool -----------------------------------------------------------------
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// -- DB helpers --------------------------------------------------------------
async function urlExists(url) {
  const [rows] = await getPool().execute(
    'SELECT COUNT(*) AS cnt FROM articles WHERE source_url = ?', [url]);
  return rows[0].cnt > 0;
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

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories WHERE site='mzamin' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='mzamin'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) { return 1; }
}

// -- Image folder ------------------------------------------------------------
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    if (imageUrl.startsWith('/'))  imageUrl = BASE_URL + imageUrl;

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer':    BASE_URL + '/',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const fname = `mzamin_${randomHex8()}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Image saved: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Parse date from meta content "YYYY-MM-DD HH:MM:SS" ---------------------
function parseMetaDate(raw) {
  if (!raw) return null;
  try {
    // meta content uses space separator: "2026-02-20 18:54:53"
    const dt = new Date(raw.trim().replace(' ', 'T'));
    return isNaN(dt) ? null : dt;
  } catch (_) { return null; }
}

// -- Extract article ID from URL ---------------------------------------------
// Format: /article/{id}/{slug}
function getArticleId(url) {
  const m = url.match(/\/article\/(\d+)\//);
  return m ? parseInt(m[1], 10) : 0;
}

// -- Fetch and parse article page --------------------------------------------
async function fetchArticle(url) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 15000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Date: meta[property="article:published_time"] content="YYYY-MM-DD HH:MM:SS"
    const metaRaw = $('meta[property="article:published_time"]').attr('content');
    const publishedAt = parseMetaDate(metaRaw);

    // Headline
    const headline = $('h1').first().text().trim().replace(/[à¥¤]+$/, '').trim();
    if (!headline || headline.length < 3) return null;

    // Content: div.prose -> <p> tags (Tailwind CSS utility selector)
    let parts = [];
    const proseDiv = $('div[class*="prose"]').first();
    if (proseDiv.length) {
      proseDiv.find('p').each((_, p) => {
        const t = $(p).text().trim();
        if (t) parts.push(t);
      });
    }
    // Fallback: any <p> with >20 chars
    if (!parts.length) {
      $('p').each((_, p) => {
        const t = $(p).text().trim();
        if (t && t.length > 20) parts.push(t);
      });
    }
    const content = parts.join('\n');
    if (!content || content.length < 20) return null;

    // Image: priority chain
    let imageUrl = '';
    // 1. div with overflow-hidden AND rounded-t-lg -> img src with /uploads/news/
    $('div').each((_, div) => {
      if (imageUrl) return;
      const cls = $(div).attr('class') || '';
      if (cls.includes('overflow-hidden') && cls.includes('rounded-t-lg')) {
        const img = $(div).find('img').first();
        const src = img.attr('src') || img.attr('data-src') || '';
        if (src.includes(UPLOADS_PATH)) imageUrl = src;
      }
    });
    // 2. img.w-full.h-auto with /uploads/news/
    if (!imageUrl) {
      $('img').each((_, img) => {
        if (imageUrl) return;
        const cls = $(img).attr('class') || '';
        if (cls.includes('w-full') && cls.includes('h-auto')) {
          const src = $(img).attr('src') || $(img).attr('data-src') || '';
          if (src.includes(UPLOADS_PATH)) imageUrl = src;
        }
      });
    }
    // 3. og:image fallback (only if contains /uploads/news/)
    if (!imageUrl) {
      const og = $('meta[property="og:image"]').attr('content') || '';
      if (og.includes(UPLOADS_PATH)) imageUrl = og;
    }

    // Category: first breadcrumb link matching /category/
    let category = '';
    $('a[href*="/category/"]').each((_, a) => {
      if (category) return;
      const t = $(a).text().trim();
      if (t && t.length < 30) category = t;
    });

    return { publishedAt, headline, content, imageUrl: imageUrl || null, category };
  } catch (e) {
    log(`  [ERROR] fetchArticle ${url}: ${String(e.message).substring(0, 80)}`);
    return null;
  }
}

// -- Process one article -----------------------------------------------------
// Returns: 'new' | 'old' | 'duplicate' | false
async function processArticle(url, cutoffDt, sectionLabel) {
  if (await urlExists(url)) {
    log('  [SKIP] Already in database');
    return 'duplicate';
  }

  const data = await fetchArticle(url);
  if (!data) {
    log('  [ERROR] Could not fetch article');
    return false;
  }

  const { publishedAt, headline, content, imageUrl, category } = data;

  // Date check
  if (cutoffDt && publishedAt) {
    if (publishedAt < cutoffDt) {
      log(`  [SKIP] Too old: ${publishedAt.toISOString()} < cutoff ${cutoffDt.toISOString()}`);
      return 'old';
    }
  } else if (!publishedAt) {
    log('  [WARN] No date found â€” processing anyway');
  }

  // Today-only mode (no last timestamp): skip if not today
  if (!cutoffDt && publishedAt) {
    const artDate = publishedAt.toISOString().substring(0, 10);
    if (artDate !== todayDateStr()) {
      log(`  [SKIP] Not today: ${artDate}`);
      return 'old';
    }
  }

  log(`  Published: ${publishedAt ? publishedAt.toISOString() : 'unknown'}`);

  // Download image
  const imageName = imageUrl ? await downloadImage(imageUrl) : null;

  // Insert
  try {
    const newId = await insertArticle({
      headline,
      isoDate:   publishedAt ? publishedAt.toISOString() : null,
      content,
      imageName,
      url,
      tags:      '',
      category:  category || sectionLabel.replace('mzamin-', ''),
      section:   sectionLabel,
    });
    if (!newId) { log('  [ERROR] DB insertion failed'); return false; }
    log(`[OK] Inserted new article (ID: ${newId})`);
    return 'new';
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') { log('  Article already exists (duplicate URL)'); return 'duplicate'; }
    log(`  [ERROR] DB: ${String(e.message).substring(0, 100)}`);
    return false;
  }
}

// -- Process one category (paginated) ----------------------------------------
async function processCategory(categoryUrl, sectionLabel, lastTimestamp) {
  log(`\n${'='.repeat(60)}`);
  log(`SECTION: ${sectionLabel}`);
  log(`URL: ${categoryUrl}`);
  log(`Last processed: ${lastTimestamp || 'Never (First Run)'}`);
  log('='.repeat(60));
  log(`[STATUS:finding:Searching ${sectionLabel}]`);

  const cycleStartTimestamp = nowStr();

  // Build cutoff datetime
  let cutoffDt = null;
  if (lastTimestamp) {
    cutoffDt = new Date(lastTimestamp.replace(' ', 'T'));
    log(`Cutoff: ${lastTimestamp}`);
  } else {
    log(`First run â€” today only (${todayDateStr()})`);
  }

  let newCount       = 0;
  let consecOld      = 0;
  let shouldStop     = false;

  for (let page = 1; page <= MAX_PAGES && !shouldStop; page++) {
    const pageUrl = page === 1 ? categoryUrl
      : (categoryUrl.endsWith('/') ? `${categoryUrl}${page}` : `${categoryUrl}/${page}`);

    log(`\nFetching page ${page}: ${pageUrl}`);

    let resp;
    try {
      resp = await retryWithBackoff(() => axios.get(pageUrl, {
        timeout: 15000,
        headers: browserHeaders(),
      }));
    } catch (e) {
      log(`  [ERROR] Page ${page} failed: ${e.message}`);
      break;
    }
    if (resp.status !== 200) { log(`  HTTP ${resp.status} â€” stopping`); break; }

    const $ = cheerio.load(resp.data);

    // Collect article links matching /article/{id}/
    const seen = new Set();
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/article\/\d+\//.test(href)) return;
      const full = href.startsWith('http') ? href : BASE_URL + href;
      if (!seen.has(full)) { seen.add(full); links.push(full); }
    });

    if (!links.length) { log(`  No article links on page ${page} â€” stopping`); break; }

    // Sort by article ID descending (newer first)
    links.sort((a, b) => getArticleId(b) - getArticleId(a));
    log(`  Found ${links.length} unique links`);

    for (let i = 0; i < links.length && !shouldStop; i++) {
      const url = links[i];
      log(`\n[p${page}/${i+1}] ${url}`);
      log(`[STATUS:extracting:${newCount}]`);

      const result = await processArticle(url, cutoffDt, sectionLabel);

      if (result === 'new') {
        newCount++;
        consecOld = 0;
      } else if (result === 'old') {
        consecOld++;
        if (consecOld >= CONSEC_OLD_STOP) {
          log(`\n  [INFO] ${consecOld} consecutive old articles â€” stopping`);
          shouldStop = true;
        }
      } else if (result === 'duplicate') {
        // duplicates don't reset or increment old counter
      } else {
        // fetch error â€” don't count against old threshold
      }

      await sleep(300);
    }

    await sleep(1000);
  }

  log(`\nSummary: ${newCount} new articles for ${sectionLabel}`);
  return { newCount, cycleStartTimestamp };
}

// -- Main loop ---------------------------------------------------------------
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('MZAMIN.COM NEWS SCRAPER - MySQL Version');
  log('='.repeat(70));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

  ensureImgFolder();

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
      log('No active Mzamin categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active mzamin categories`);

    const cycleStart = Date.now();
    log(`\n${'='.repeat(70)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(70) + '\n');

    let totalNew = 0;
    const updatedDates = { ...lastProcessedDates };

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      const lastTimestamp = lastProcessedDates[sectionLabel] || null;

      const { newCount, cycleStartTimestamp } = await processCategory(
        categoryUrl, sectionLabel, lastTimestamp);

      totalNew += newCount;
      updatedDates[sectionLabel] = cycleStartTimestamp;

      await sleep(2000);
    }

    saveLastProcessedDates(updatedDates);
    lastProcessedDates = updatedDates;
    log('\nTimestamps updated for all sections');

    log('\n' + '='.repeat(70));
    log(`CYCLE COMPLETED: ${totalNew} new articles added`);
    log('='.repeat(70));

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
      log(`\nCycle took ${cycleDuration}s (longer than ${CYCLE_TIME}s). Starting next immediately...\n`);
    }
  }

  if (pool) await pool.end();
}

main().catch(e => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
