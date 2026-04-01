#!/usr/bin/env node
'use strict';

/**
 * Janakantha Scraper - Node.js
 * Ported from janakantha-scraper/scrapjanakantha_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Architecture:
 *  - Category pages paginate via AJAX endpoint (ajax_news_load_more.php)
 *  - iCategoryID + totalRecord + rowperpage extracted from inline JS on category page
 *  - Cursor: div.countclass[data-content] — last element's value tracks position
 *  - Article links matched by: /{category_slug}/news/
 *  - Date: div.pDate text (Bengali numerals + Bengali months)
 *          Fallback: meta[property="article:published_time"]
 *          Bengali date format: "প্রকাশিত: ১০:৪৪, ১৬ ফেব্রুয়ারি ২০২৬"
 *          English formats after conversion: "HH:MM, DD Month YYYY" or "DD Month YYYY, HH:MM"
 *  - Stops after CONSEC_OLD_STOP=3 consecutive old articles (across all pages)
 *  - Content: article.DDetailsContent -> <p>; fallback article -> <p>
 *  - Image: img.TopImg src; fallback og:image; strip -fb. suffix for original quality
 *  - Tags: div.tags / div.article-tags -> <a> texts
 *  - Image filename: janakantha_{8-char random hex}.jpg
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
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'janakantha.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'janakantha');
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
const BASE_URL        = 'https://www.dailyjanakantha.com';
const BASE_DOMAIN     = 'janakantha';
const AJAX_URL        = 'https://www.dailyjanakantha.com/ajax_news_load_more.php';
const MAX_AJAX_PAGES  = 20;
const CONSEC_OLD_STOP = 3;

const SECTION_TO_CATEGORY_ID = {
  national:      5,
  politics:     10,
  economics:     9,
  international: 6,
  sports:        8,
  entertainment: 14,
  crime:         7,
  education:    13,
};

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// Bengali → ASCII digit map
const BN_DIGITS = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };
// Bengali month → English month
const BN_MONTHS = {
  'জানুয়ারি':'January','জানুয়ারী':'January',
  'ফেব্রুয়ারি':'February','ফেব্রুয়ারী':'February',
  'মার্চ':'March','এপ্রিল':'April','মে':'May',
  'জুন':'June','জুলাই':'July','আগস্ট':'August',
  'সেপ্টেম্বর':'September','অক্টোবর':'October',
  'নভেম্বর':'November','ডিসেম্বর':'December',
};

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

function browserHeaders(referer) {
  const h = {
    'User-Agent': randomUA(),
    'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (referer) h['Referer'] = referer;
  return h;
}

// -- Cycle time --------------------------------------------------------------
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['janakantha'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// -- Last-processed dates ----------------------------------------------------
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

// -- DB pool -----------------------------------------------------------------
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

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
    `SELECT category_url, section_label FROM categories WHERE site='janakantha' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='janakantha'`);
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
    const fname = `janakantha_${randomHex8()}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Image saved: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Bengali date parser -----------------------------------------------------
function convertBengaliDigits(s) {
  return s.replace(/[০-৯]/g, c => BN_DIGITS[c] || c);
}

function convertBengaliMonth(s) {
  for (const [bn, en] of Object.entries(BN_MONTHS)) {
    if (s.includes(bn)) return s.replace(bn, en);
  }
  return s;
}

// Parses div.pDate text like "প্রকাশিত: ১০:৪৪, ১৬ ফেব্রুয়ারি ২০২৬"
// Returns a Date object or null
function parseBengaliDate(raw) {
  if (!raw) return null;
  try {
    let s = raw.replace('প্রকাশিত:', '').replace('প্রকাশিত', '').trim();
    s = convertBengaliDigits(s);
    s = convertBengaliMonth(s);

    // Pattern 1: HH:MM, DD Month YYYY  (time first)
    let m = s.match(/(\d{1,2}):(\d{2}),\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (m) {
      const [, hh, mm, dd, mon, yyyy] = m;
      return new Date(`${dd} ${mon} ${yyyy} ${hh}:${mm}:00`);
    }

    // Pattern 2: DD Month YYYY, HH:MM  (date first)
    m = s.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/i);
    if (m) {
      const [, dd, mon, yyyy, hh, mm] = m;
      return new Date(`${dd} ${mon} ${yyyy} ${hh}:${mm}:00`);
    }

    // Pattern 3: DD Month YYYY  (date only)
    m = s.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (m) {
      const [, dd, mon, yyyy] = m;
      return new Date(`${dd} ${mon} ${yyyy}`);
    }

    return null;
  } catch (_) { return null; }
}

// -- Collect article links from cheerio HTML ---------------------------------
function extractLinks($, categorySlug) {
  const pattern = `/${categorySlug}/news/`;
  const seen  = new Set();
  const links = [];
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    if (href.startsWith('//'))     href = 'https:' + href;
    else if (href.startsWith('/')) href = BASE_URL + href;
    if (!href.startsWith('http')) return;
    if (!href.includes(pattern)) return;
    if (!seen.has(href)) { seen.add(href); links.push(href); }
  });
  return links;
}

// -- Fetch and parse article page --------------------------------------------
async function fetchArticle(url) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 15000,
      headers: browserHeaders(BASE_URL + '/'),
    }));
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Date — primary: div.pDate (Bengali)
    let publishedAt = null;
    const pDateText = $('div.pDate').first().text().trim();
    if (pDateText) publishedAt = parseBengaliDate(pDateText);

    // Date — fallback: meta[property="article:published_time"]
    if (!publishedAt) {
      const metaContent = $('meta[property="article:published_time"]').attr('content');
      if (metaContent) {
        const dt = new Date(metaContent.replace('Z', '+00:00'));
        if (!isNaN(dt)) publishedAt = dt;
      }
    }

    // Headline
    const headline = $('h1').first().text().trim();
    if (!headline || headline.length < 3) return null;

    // Content: article.DDetailsContent → <p>; fallback article → <p>
    let parts = [];
    for (const sel of ['article.DDetailsContent', 'article']) {
      const el = $(sel).first();
      if (el.length) {
        el.find('p').each((_, p) => {
          const t = $(p).text().trim();
          if (t && t.length > 20) parts.push(t);
        });
        if (parts.length) break;
      }
    }
    const content = parts.join(' ');

    // Image: img.TopImg src; fallback og:image; strip -fb. suffix
    let imageUrl = $('img.TopImg').first().attr('src') || '';
    if (!imageUrl) imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (imageUrl && imageUrl.includes('-fb.')) imageUrl = imageUrl.replace('-fb.', '.');

    // Tags: div.tags / div.article-tags → <a> texts
    const tagList = [];
    for (const sel of ['div.tags', 'div.article-tags']) {
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
  if (!data) { log('  [ERROR] Could not fetch article'); return false; }

  const { publishedAt, headline, content, imageUrl, tags } = data;

  // Date check
  if (cutoffDt && publishedAt) {
    if (publishedAt < cutoffDt) {
      log(`  [SKIP] Too old: ${publishedAt.toISOString()} < cutoff ${cutoffDt.toISOString()}`);
      return 'old';
    }
  } else if (!publishedAt) {
    log('  [WARN] No date found — processing anyway');
  }

  // Today-only mode (first run)
  if (!cutoffDt && publishedAt) {
    const artDate = publishedAt.toISOString().substring(0, 10);
    if (artDate !== todayDateStr()) {
      log(`  [SKIP] Not today: ${artDate}`);
      return 'old';
    }
  }

  log(`  Published: ${publishedAt ? publishedAt.toISOString() : 'unknown'}`);

  const imageName = imageUrl ? await downloadImage(imageUrl) : null;

  try {
    const newId = await insertArticle({
      headline,
      isoDate:  publishedAt ? publishedAt.toISOString() : null,
      content,
      imageName,
      url,
      tags,
      category: categoryId,
      section:  sectionLabel,
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

// -- Process one category (with AJAX pagination) -----------------------------
async function processCategory(categoryUrl, sectionLabel, lastTimestamp) {
  log(`\n${'='.repeat(60)}`);
  log(`SECTION: ${sectionLabel}`);
  log(`URL: ${categoryUrl}`);
  log(`Last processed: ${lastTimestamp || 'Never (First Run)'}`);
  log('='.repeat(60));
  log(`[STATUS:finding:Searching ${sectionLabel}]`);

  const cycleStartTimestamp = nowStr();

  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();
  const categoryId   = SECTION_TO_CATEGORY_ID[categorySlug] || 5;

  // Build cutoff datetime
  let cutoffDt = null;
  if (lastTimestamp) {
    cutoffDt = new Date(lastTimestamp.replace(' ', 'T'));
    log(`Cutoff: ${lastTimestamp}`);
  } else {
    log(`First run — today only (${todayDateStr()})`);
  }

  // -- Fetch category page 1 ------------------------------------------------
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
    log(`  HTTP ${resp.status} — skipping`);
    return { newCount: 0, cycleStartTimestamp };
  }

  const $ = cheerio.load(resp.data);

  // Extract AJAX params from inline JS
  let ajaxCatId  = null;
  let ajaxTotal  = null;
  let ajaxRpp    = 16;
  $('script').each((_, sc) => {
    const t = $(sc).html() || '';
    if (!t.includes('iCategoryID')) return;
    const mCat = t.match(/iCategoryID\s*=\s*(\d+)/);
    const mTot = t.match(/totalRecord\s*=\s*(\d+)/);
    const mRpp = t.match(/rowperpage\s*=\s*(\d+)/);
    if (mCat) ajaxCatId = mCat[1];
    if (mTot) ajaxTotal = parseInt(mTot[1], 10);
    if (mRpp) ajaxRpp   = parseInt(mRpp[1], 10);
    return false; // break
  });

  if (!ajaxCatId) log(`  [WARN] iCategoryID not found — pagination disabled`);

  // Get cursor from last .countclass[data-content] on page 1
  let newsCount = ajaxRpp;
  const countItems = $('.countclass[data-content]');
  if (countItems.length) {
    const last = countItems.last().attr('data-content');
    if (last) newsCount = parseInt(last, 10) || ajaxRpp;
  }

  // Process page 1 links
  const page1Links = extractLinks($, categorySlug);
  log(`Found ${page1Links.length} links on page 1`);

  let newCount   = 0;
  let consecOld  = 0;
  let shouldStop = false;

  for (let i = 0; i < page1Links.length && !shouldStop; i++) {
    const url = page1Links[i];
    log(`\n[p1/${i+1}] ${url}`);
    log(`[STATUS:extracting:${newCount}]`);

    const result = await processArticle(url, cutoffDt, sectionLabel, categoryId);

    if (result === 'new')       { newCount++; consecOld = 0; }
    else if (result === 'old')  { consecOld++; if (consecOld >= CONSEC_OLD_STOP) { log(`  [INFO] ${consecOld} consecutive old — stopping`); shouldStop = true; } }
    // duplicate/error: don't affect consecOld

    await sleep(500);
  }

  // -- AJAX pagination -------------------------------------------------------
  if (ajaxCatId && ajaxTotal && !shouldStop) {
    for (let pageNum = 2; pageNum <= MAX_AJAX_PAGES + 1 && !shouldStop; pageNum++) {
      if (newsCount >= ajaxTotal) {
        log(`\n  [INFO] End of category (${newsCount}/${ajaxTotal})`);
        break;
      }

      log(`\n  [AJAX page ${pageNum}] newsCount=${newsCount}`);

      let ajaxResp;
      try {
        const params = new URLSearchParams({
          action:      'showContent',
          newsCount:   String(newsCount),
          totalRecord: String(ajaxTotal),
          rowperpage:  String(ajaxRpp),
          iCategoryID: ajaxCatId,
          iSlugName:   categorySlug,
        });
        ajaxResp = await retryWithBackoff(() => axios.post(AJAX_URL, params.toString(), {
          timeout: 15000,
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer':          categoryUrl,
            'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        }));
      } catch (e) {
        log(`  [AJAX-ERROR] ${e.message}`);
        break;
      }

      if (ajaxResp.status !== 200 || !ajaxResp.data?.trim()) {
        log('  [INFO] AJAX empty/error — stopping pagination');
        break;
      }

      const $ajax = cheerio.load(ajaxResp.data);
      const batchLinks = extractLinks($ajax, categorySlug);
      log(`  ${batchLinks.length} links in AJAX batch`);

      if (!batchLinks.length) { log('  No links — stopping pagination'); break; }

      for (let i = 0; i < batchLinks.length && !shouldStop; i++) {
        const url = batchLinks[i];
        log(`\n[p${pageNum}/${i+1}] ${url}`);
        log(`[STATUS:extracting:${newCount}]`);

        const result = await processArticle(url, cutoffDt, sectionLabel, categoryId);

        if (result === 'new')       { newCount++; consecOld = 0; }
        else if (result === 'old')  { consecOld++; if (consecOld >= CONSEC_OLD_STOP) { log(`  [INFO] ${consecOld} consecutive old — stopping`); shouldStop = true; } }

        await sleep(500);
      }

      // Advance cursor
      const newCountItems = $ajax('.countclass[data-content]');
      if (newCountItems.length) {
        const last = newCountItems.last().attr('data-content');
        if (last) newsCount = parseInt(last, 10) || newsCount + ajaxRpp;
      } else {
        newsCount += ajaxRpp;
      }

      await sleep(1000);
    }
  }

  log(`\nSummary: ${newCount} new articles for ${sectionLabel}`);
  return { newCount, cycleStartTimestamp };
}

// -- Main loop ---------------------------------------------------------------
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('JANAKANTHA.COM NEWS SCRAPER - MySQL Version');
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
      log('No active Janakantha categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active janakantha categories`);

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
