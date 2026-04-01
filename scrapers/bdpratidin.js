#!/usr/bin/env node
'use strict';

/**
 * BD Pratidin Scraper - Node.js
 * Ported from bdpratidin-scraper/scrapbdpratidin_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Architecture:
 *  - Category page: standard HTML, extract article hrefs matching
 *    /{category_slug}/YYYY/MM/DD/{id}  — date embedded in URL for fast pre-filtering
 *  - Per article: fetch full page once (vs. Python's two-fetch optimization),
 *    extract meta published_time (ISO), headline, content, image, tags
 *  - Timestamp window: last_dt < article_dt <= cycle_start_dt
 *  - No last_timestamp: only today's articles (URL date == today)
 *  - cycle_start_timestamp captured before category extraction to avoid
 *    missing articles published during processing
 *  - Image: og:image with /og/ removed to get banner-free original
 *    e.g. .../2026/02/18/og/file.jpg -> .../2026/02/18/file.jpg
 *  - Insert article first, then download image and UPDATE row
 *  - 5 consecutive old/duplicate -> stop early
 *  - No pagination (single category page per cycle)
 *  - Reads cycle time from scraper_cycle_config.json (default 600s)
 *  - Emits [STATUS:...] tokens parsed by server.js
 *  - Emits [OK] Inserted new article (ID: X) for server.js article counting
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// -- Paths -------------------------------------------------------------------
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'bdpratidin.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'bdpratidin');
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
const BASE_URL    = 'https://www.bd-pratidin.com';
const BASE_DOMAIN = 'bdpratidin';

const MAX_CONSECUTIVE_OLD = 5;

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Article URL pattern: /{categorySlug}/YYYY/MM/DD/{id}
// Used both for href matching and date extraction
const ARTICLE_URL_RE = /^\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)\/?$/;
const ARTICLE_URL_ABS_RE = /^https?:\/\/[^/]+\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)\/?$/;

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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

// -- Cycle time --------------------------------------------------------------
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['bdpratidin'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// -- Last-processed timestamps -----------------------------------------------
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

async function insertArticle({ headline, isoDate, content, url, tags, category, section }) {
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
    [headline, headline, pubDt, content || '', null,
     url, BASE_DOMAIN, tags || '', String(category), section]);
  return result.insertId;
}

async function updateArticleImage(id, imageName) {
  await getPool().execute('UPDATE articles SET image_name = ? WHERE id = ?', [imageName, id]);
}

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories WHERE site='bdpratidin' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='bdpratidin'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) { return 1; }
}

// -- Image folder ------------------------------------------------------------
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl, articleId) {
  if (!imageUrl) return null;
  try {
    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer':    BASE_URL + '/',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const fname = `${BASE_DOMAIN}_${articleId}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Image saved: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Extract article URLs from category page ---------------------------------
// Pre-filters by date:
//  - If lastTimestamp exists: URL date >= cutoff_date (date part of lastTimestamp)
//  - If no lastTimestamp: URL date == today
async function extractArticleUrls(categoryUrl, lastTimestamp) {
  try {
    const resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 30000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return [];

    const $ = cheerio.load(resp.data);

    // Determine cutoff date string YYYY-MM-DD
    // For আপডেট (updated) articles: their URL contains the ORIGINAL publish date,
    // which may be older than lastTimestamp. To catch these, we look back 7 days
    // from the cutoff so updated articles aren't dropped at the URL-scan stage.
    // Actual timestamp filtering happens in processArticle using meta tags.
    let cutoffDate   = null;
    let todayOnly    = false;
    const todayStr   = todayDateStr();

    if (lastTimestamp) {
      // Look back 7 days to catch articles that were updated recently
      const cutoffDt = new Date(lastTimestamp.replace(' ', 'T'));
      cutoffDt.setDate(cutoffDt.getDate() - 7);
      cutoffDate = cutoffDt.toISOString().substring(0, 10);
      log(`  URL date filter: >= ${cutoffDate} (7-day lookback for updated articles)`);
    } else {
      todayOnly = true;
      log(`  URL date filter: today only (${todayStr})`);
    }

    // Extract category slug from category URL to anchor regex
    const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();
    const relRe = new RegExp(`^\\/${categorySlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\d{4}\\/\\d{2}\\/\\d{2}\\/\\d+\\/?$`);
    const absRe = new RegExp(`^https?:\\/\\/[^/]+\\/${categorySlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\d{4}\\/\\d{2}\\/\\d{2}\\/\\d+\\/?$`);

    const seen      = new Set();
    const articleUrls = [];
    let   totalFound  = 0;
    let   filteredOut = 0;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';

      // Match relative or absolute URL
      let m = href.match(ARTICLE_URL_RE) || href.match(ARTICLE_URL_ABS_RE);
      if (!m) return;

      // Also enforce category slug prefix
      if (!relRe.test(href) && !absRe.test(href)) return;

      // Groups: [1]=slug, [2]=year, [3]=month, [4]=day, [5]=id
      const year  = m[2], month = m[3], day = m[4];
      const urlDateStr = `${year}-${month}-${day}`;

      totalFound++;

      // Date filter
      if (todayOnly) {
        // First run: accept today's URLs and also articles from last 7 days
        // (some may have been updated today with an older original publish date)
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = weekAgo.toISOString().substring(0, 10);
        if (urlDateStr < weekAgoStr) { filteredOut++; return; }
      } else {
        if (urlDateStr < cutoffDate) { filteredOut++; return; }
      }

      // Build full URL
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (!seen.has(fullUrl)) {
        seen.add(fullUrl);
        articleUrls.push(fullUrl);
      }
    });

    log(`  Found ${totalFound} total links, ${filteredOut} filtered (old), ${articleUrls.length} to process`);
    return articleUrls;
  } catch (e) {
    log(`  [ERROR] extractArticleUrls: ${String(e.message).substring(0, 100)}`);
    return [];
  }
}

// -- Fetch and parse article -------------------------------------------------
async function fetchArticle(articleUrl) {
  try {
    const resp = await retryWithBackoff(() => axios.get(articleUrl, {
      timeout: 30000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Published time and modified time from meta (ISO format)
    // Some articles show only আপডেট (update) time — modified_time may differ from published_time
    const pubMeta = $('meta[property="article:published_time"]').attr('content');
    const modMeta = $('meta[property="article:modified_time"]').attr('content');
    const publishedAt = pubMeta ? new Date(pubMeta) : null;
    const modifiedAt  = modMeta ? new Date(modMeta)  : null;
    // Need at least one valid date
    if ((!publishedAt || isNaN(publishedAt)) && (!modifiedAt || isNaN(modifiedAt))) return null;

    // Headline
    let headline = $('h1.card-title').first().text().trim();
    if (!headline) headline = $('h1').first().text().trim();
    if (!headline) return null;

    // Content: try <article> first; fall back to section.container for
    // digest/roundup articles that have no <article> wrapper.
    // Collect <p>, <h3>, and <li> text so digest formats (h3+p or li lists) work too.
    const CONTENT_SELECTORS = ['article', 'section.container'];
    let contentEl = null;
    for (const sel of CONTENT_SELECTORS) {
      const el = $(sel).first();
      if (el.length) {
        const richCount = el.find('p, h3, li').toArray()
          .filter(x => $(x).text().trim().length > 20).length;
        if (richCount > 0) { contentEl = el; break; }
      }
    }
    if (!contentEl) return null;

    const parts = [];
    contentEl.find('p, h3, li').each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 20) parts.push(t);
    });
    const content = parts.join('\n\n');
    if (!content) return null;

    // Image: og:image with /og/ removed to get banner-free original
    // Pattern: .../YYYY/MM/DD/og/filename.jpg -> .../YYYY/MM/DD/filename.jpg
    let imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (imageUrl && imageUrl.includes('/og/')) {
      imageUrl = imageUrl.replace('/og/', '/');
    }

    // Tags: div.tagArea a
    const tags = [];
    $('div.tagArea a').each((_, el) => {
      const t = $(el).text().trim();
      if (t) tags.push(t);
    });

    return {
      publishedAt: (publishedAt && !isNaN(publishedAt)) ? publishedAt : null,
      modifiedAt:  (modifiedAt  && !isNaN(modifiedAt))  ? modifiedAt  : null,
      headline,
      content,
      imageUrl:    imageUrl || null,
      tags:        tags.join(', '),
    };
  } catch (e) {
    log(`  [ERROR] fetchArticle: ${String(e.message).substring(0, 80)}`);
    return null;
  }
}

// -- Process one article -----------------------------------------------------
// Returns: 'new' | 'old' | 'duplicate' | false
async function processArticle(articleUrl, lastTimestamp, cycleStartTimestamp, category, section) {
  // Check DB first
  if (await urlExists(articleUrl)) {
    log('  [SKIP] Already in database');
    return 'duplicate';
  }

  // Fetch article (gets date + full content in one request)
  const data = await fetchArticle(articleUrl);
  if (!data) {
    log('  [ERROR] Could not fetch article');
    return false;
  }

  const { publishedAt, modifiedAt, headline, content, imageUrl, tags } = data;

  // Timestamp filtering — check both published and modified times.
  // Articles showing আপডেট (update) may have an old published_time but a
  // recent modified_time that falls inside the current window.
  let effectiveDt = publishedAt; // the time we'll store in DB

  if (lastTimestamp) {
    const lastDt       = new Date(lastTimestamp.replace(' ', 'T'));
    const cycleStartDt = new Date(cycleStartTimestamp.replace(' ', 'T'));

    const inWindow = dt => dt && dt.getTime() > lastDt.getTime() && dt.getTime() <= cycleStartDt.getTime();
    const pubOk = publishedAt && inWindow(publishedAt);
    const modOk = modifiedAt  && inWindow(modifiedAt);

    if (!pubOk && !modOk) {
      const pubStr = publishedAt ? publishedAt.toISOString() : 'N/A';
      const modStr = modifiedAt  ? modifiedAt.toISOString()  : 'N/A';
      log(`  [SKIP] Outside window — published: ${pubStr}, modified: ${modStr}`);
      return 'old';
    }
    // Prefer published if in window; else use modified (আপডেট article)
    if (!pubOk && modOk) {
      effectiveDt = modifiedAt;
      log(`  [INFO] Using update time (published outside window)`);
    }
  } else {
    // No last timestamp: today only — accept if either date is today
    const today = todayDateStr();
    const pubDate = publishedAt ? publishedAt.toISOString().substring(0, 10) : null;
    const modDate = modifiedAt  ? modifiedAt.toISOString().substring(0, 10)  : null;
    if (pubDate !== today && modDate !== today) {
      log(`  [SKIP] Not today — published: ${pubDate || 'N/A'}, modified: ${modDate || 'N/A'}`);
      return 'old';
    }
    if (pubDate !== today && modDate === today) {
      effectiveDt = modifiedAt;
      log(`  [INFO] Using update time (published date is not today)`);
    }
  }

  log(`  Published: ${effectiveDt ? effectiveDt.toISOString() : 'N/A'}`);

  // Insert article (image_name = null initially)
  let newId;
  try {
    newId = await insertArticle({
      headline,
      isoDate:  effectiveDt ? effectiveDt.toISOString() : null,
      content,
      url:      articleUrl,
      tags,
      category,
      section,
    });
    if (!newId) {
      log('  [ERROR] Database insertion failed');
      return false;
    }
    log(`[OK] Inserted new article (ID: ${newId})`);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      log('  Article already exists (duplicate URL)');
      return 'duplicate';
    }
    log(`  [ERROR] DB error: ${String(e.message).substring(0, 100)}`);
    return false;
  }

  // Download image and update DB row
  if (imageUrl) {
    const fname = await downloadImage(imageUrl, newId);
    if (fname) {
      try { await updateArticleImage(newId, fname); }
      catch (e) { log(`  [WARN] Could not update image in DB: ${e.message}`); }
    }
  }

  return 'new';
}

// -- Process one category ----------------------------------------------------
async function processCategory(categoryUrl, sectionLabel, lastTimestamp) {
  log(`\n${'='.repeat(60)}`);
  log(`SECTION: ${sectionLabel}`);
  log(`URL: ${categoryUrl}`);
  log(`Last processed: ${lastTimestamp || 'Never (First Run)'}`);
  log('='.repeat(60));
  log(`[STATUS:finding:${sectionLabel}]`);

  // Capture cycle-start timestamp BEFORE extraction to avoid missing
  // articles published while we are scraping this category
  const cycleStartTimestamp = nowStr();
  log(`Cycle start: ${cycleStartTimestamp}`);

  if (lastTimestamp) {
    log(`Filter: ${lastTimestamp} < article_dt <= ${cycleStartTimestamp}`);
  } else {
    log(`Filter: today only (${todayDateStr()})`);
  }

  // Category slug from URL
  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();

  // Extract article URLs (pre-filtered by URL-embedded date)
  const articleUrls = await extractArticleUrls(categoryUrl, lastTimestamp);
  if (!articleUrls.length) {
    log('No articles found on category page');
    return { newCount: 0, cycleStartTimestamp };
  }

  let newCount        = 0;
  let consecutiveOld  = 0;

  for (let i = 0; i < articleUrls.length; i++) {
    const articleUrl = articleUrls[i];
    log(`\n[${i+1}/${articleUrls.length}] ${articleUrl}`);
    log(`[STATUS:extracting:${newCount}]`);

    const result = await processArticle(
      articleUrl, lastTimestamp, cycleStartTimestamp, categorySlug, sectionLabel);

    if (result === 'new') {
      newCount++;
      consecutiveOld = 0;
    } else {
      consecutiveOld++;
      if (consecutiveOld >= MAX_CONSECUTIVE_OLD) {
        log(`\n  [INFO] ${consecutiveOld} consecutive old/duplicate articles — stopping early`);
        log(`  [INFO] Processed ${i+1}/${articleUrls.length} URLs from page`);
        break;
      }
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

  log('='.repeat(60));
  log('BD PRATIDIN SCRAPER - MySQL Version');
  log('='.repeat(60));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(60));

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
      log('No active BD Pratidin categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nFound ${categories.length} active categories`);

    const cycleStart = Date.now();
    log(`\n${'='.repeat(60)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(60) + '\n');

    let totalNew = 0;
    const updatedDates = { ...lastProcessedDates };

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      const lastTimestamp = lastProcessedDates[sectionLabel] || null;

      const { newCount, cycleStartTimestamp } = await processCategory(
        categoryUrl, sectionLabel, lastTimestamp);

      totalNew += newCount;

      // Save cycle-start timestamp as new cutoff for this section
      updatedDates[sectionLabel] = cycleStartTimestamp;

      await sleep(2000);
    }

    // Save all timestamps after cycle
    saveLastProcessedDates(updatedDates);
    lastProcessedDates = updatedDates;
    log('\nTimestamps updated for all sections');

    log('\n' + '='.repeat(60));
    log(`CYCLE COMPLETED: ${totalNew} new articles added`);
    log('='.repeat(60));

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
