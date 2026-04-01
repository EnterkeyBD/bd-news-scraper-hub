#!/usr/bin/env node
'use strict';

/**
 * Dhaka Tribune Scraper - Node.js
 * Ported from dhakatribune-scraper/scrapdhakatribune_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Architecture:
 *  - Category pages are single-page (no pagination)
 *  - Article links: /{category_slug}/{id}/{slug} â€” numeric ID in path
 *  - Date: meta[property="article:published_time"] (ISO 8601)
 *          fallback: div.time text "Publish : 15 Feb 2026, 07:56 PM"
 *  - Cutoff: articles with publishedAt >= cutoffDt are processed
 *            (skip if publishedAt < cutoffDt)
 *  - No consecutive-old counter (links are unordered on category page)
 *  - Content: article.jw_detail_content_holder -> <p> tags
 *             fallback: div.content_detail_each_group -> <p>
 *             fallback: article -> <p>
 *  - Image: meta[property="og:image"] â€” strip ?watermark=... query param
 *  - Tags: div.content_tags / div.more_and_tag / div.tags -> <a> texts
 *  - Image filename: dhakatribune_{8-char random hex}.jpg
 *  - First run (no lastTimestamp): today-only mode
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
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'dhakatribune.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'dhakatribune');
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
const BASE_URL    = 'https://www.dhakatribune.com';
const BASE_DOMAIN = 'dhakatribune';

// Category slug â†’ DB category ID
const SECTION_TO_CATEGORY_ID = {
  bangladesh:   5,
  world:        6,
  sports:       8,
  sport:        8,
  entertainment: 14,
  business:     9,
  opinion:      11,
  environment:  12,
  tech:         15,
};

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MONTH_MAP = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
                    Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

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
    const v = cfg['dhakatribune'];
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
    `SELECT category_url, section_label FROM categories WHERE site='dhakatribune' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='dhakatribune'`);
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
    const fname = `dhakatribune_${randomHex8()}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Image saved: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Date parsing ------------------------------------------------------------
// Parses "15 Feb 2026, 07:56 PM" or "Publish : 15 Feb 2026, 07:56 PM ..."
function parseDhakatribuneDate(text) {
  let s = text || '';
  if (s.includes('Publish :')) s = s.split('Publish :')[1].split('Update')[0];
  s = s.replace('Tribune Report', '').trim();

  // "15 Feb 2026, 07:56 PM"
  const m = s.match(/(\d{1,2})\s+(\w{3})\s+(\d{4}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (m) {
    const [, day, mon, year, hr, min, ampm] = m;
    const month = MONTH_MAP[mon] ?? null;
    if (month === null) return null;
    let hours = parseInt(hr, 10);
    if (ampm && ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    return new Date(parseInt(year), month, parseInt(day), hours, parseInt(min), 0);
  }
  // Date-only fallback "15 Feb 2026"
  const m2 = s.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (m2) {
    const [, day, mon, year] = m2;
    const month = MONTH_MAP[mon] ?? null;
    if (month === null) return null;
    return new Date(parseInt(year), month, parseInt(day));
  }
  return null;
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

    // Date: meta[property="article:published_time"] (ISO 8601) â€” primary
    let publishedAt = null;
    const metaContent = $('meta[property="article:published_time"]').attr('content');
    if (metaContent) {
      const dt = new Date(metaContent.replace('Z', '+00:00'));
      if (!isNaN(dt)) publishedAt = dt;
    }
    // Fallback: div.time text "Publish : 15 Feb 2026, 07:56 PM"
    if (!publishedAt) {
      const timeText = $('div.time').first().text().trim();
      if (timeText) publishedAt = parseDhakatribuneDate(timeText);
    }

    // Headline: h1.title or h1
    let headline = $('h1.title').first().text().trim();
    if (!headline) headline = $('h1').first().text().trim();
    if (!headline || headline.length < 3) return null;

    // Content: article.jw_detail_content_holder -> <p>
    let parts = [];
    const contentSelectors = [
      'article.jw_detail_content_holder',
      'div.content_detail_each_group',
      'article',
    ];
    for (const sel of contentSelectors) {
      const el = $(sel).first();
      if (el.length) {
        el.find('p').each((_, p) => {
          const t = $(p).text().trim();
          if (t && t.length > 20) parts.push(t);
        });
        if (parts.length) break;
      }
    }
    // Last-resort fallback
    if (!parts.length) {
      $('p').each((_, p) => {
        const t = $(p).text().trim();
        if (t && t.length > 20) parts.push(t);
      });
    }
    const content = parts.join(' ');

    // Image: og:image â€” strip ?watermark=... query param
    let imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (imageUrl && imageUrl.includes('?watermark=')) {
      imageUrl = imageUrl.split('?watermark=')[0];
    }

    // Tags: div.content_tags / div.more_and_tag / div.tags -> <a> texts
    const tagSelectors = ['div.content_tags', 'div.more_and_tag', 'div.tags'];
    const tagList = [];
    for (const sel of tagSelectors) {
      const el = $(sel).first();
      if (el.length) {
        el.find('a').each((_, a) => {
          const t = $(a).text().trim();
          if (t) tagList.push(t);
        });
        if (tagList.length) break;
      }
    }
    const tags = tagList.join(', ');

    return { publishedAt, headline, content, imageUrl: imageUrl || null, tags };
  } catch (e) {
    log(`  [ERROR] fetchArticle ${url}: ${String(e.message).substring(0, 80)}`);
    return null;
  }
}

// -- Process one article -----------------------------------------------------
// Returns: 'new' | 'old' | 'duplicate' | false
async function processArticle(url, cutoffDt, sectionLabel, categoryId) {
  if (await urlExists(url)) {
    log('  [SKIP] Already in database');
    return 'duplicate';
  }

  const data = await fetchArticle(url);
  if (!data) {
    log('  [ERROR] Could not fetch article');
    return false;
  }

  const { publishedAt, headline, content, imageUrl, tags } = data;

  // Date check â€” skip if too old
  if (cutoffDt && publishedAt) {
    if (publishedAt < cutoffDt) {
      log(`  [SKIP] Too old: ${publishedAt.toISOString()} < cutoff ${cutoffDt.toISOString()}`);
      return 'old';
    }
  } else if (!publishedAt) {
    log('  [WARN] No date found â€” processing anyway');
  }

  // Today-only mode (first run, no lastTimestamp)
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
      tags,
      category:  categoryId,
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

// -- Process one category ----------------------------------------------------
async function processCategory(categoryUrl, sectionLabel, lastTimestamp) {
  log(`\n${'='.repeat(60)}`);
  log(`SECTION: ${sectionLabel}`);
  log(`URL: ${categoryUrl}`);
  log(`Last processed: ${lastTimestamp || 'Never (First Run)'}`);
  log('='.repeat(60));
  log(`[STATUS:finding:Searching ${sectionLabel}]`);

  const cycleStartTimestamp = nowStr();

  // Derive category slug and DB category ID from URL
  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();
  const categoryId   = SECTION_TO_CATEGORY_ID[categorySlug] || 5;

  // Build cutoff datetime
  let cutoffDt = null;
  if (lastTimestamp) {
    cutoffDt = new Date(lastTimestamp.replace(' ', 'T'));
    log(`Cutoff: ${lastTimestamp}`);
  } else {
    log(`First run â€” today only (${todayDateStr()})`);
  }

  // Fetch category page
  let resp;
  try {
    resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 15000,
      headers: browserHeaders(),
    }));
  } catch (e) {
    log(`  [ERROR] Failed to fetch category page: ${e.message}`);
    return { newCount: 0, cycleStartTimestamp };
  }
  if (resp.status !== 200) {
    log(`  HTTP ${resp.status} â€” skipping category`);
    return { newCount: 0, cycleStartTimestamp };
  }

  const $ = cheerio.load(resp.data);

  // Collect article links: must contain /{category_slug}/ and a numeric segment
  const seen  = new Set();
  const links = [];
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    if (!href) return;
    // Make absolute (handle protocol-relative before single-slash)
    if (href.startsWith('//'))     href = 'https:' + href;
    else if (href.startsWith('/')) href = BASE_URL + href;
    if (!href.startsWith('http')) return;
    // Must be on dhakatribune.com, in the right category, and contain a number segment
    if (!href.includes('dhakatribune.com')) return;
    if (!href.includes(`/${categorySlug}/`)) return;
    if (!/\/\d+\//.test(href)) return;
    if (!seen.has(href)) { seen.add(href); links.push(href); }
  });

  log(`Found ${links.length} unique article links`);

  let newCount = 0;
  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    log(`\n[${i+1}/${links.length}] ${url}`);
    log(`[STATUS:extracting:${newCount}]`);

    const result = await processArticle(url, cutoffDt, sectionLabel, categoryId);
    if (result === 'new') newCount++;

    await sleep(500);
  }

  log(`\nSummary: ${newCount} new articles for ${sectionLabel}`);
  return { newCount, cycleStartTimestamp };
}

// -- Main loop ---------------------------------------------------------------
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('DHAKATRIBUNE.COM NEWS SCRAPER - MySQL Version');
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
      log('No active Dhaka Tribune categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active dhakatribune categories`);

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
