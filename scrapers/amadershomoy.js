#!/usr/bin/env node
'use strict';

/**
 * AmaderShomoy Scraper - Node.js
 * Ported from amadershomoy-scraper/scrapamadershomoy_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Hybrid DOM+API approach:
 *  1. Category page: GET category_url, parse __NUXT_DATA__ JSON to extract slugs
 *     - Only reads category_all_news key (NOT latest_recent / news_categories_all_data
 *       which are sidebar sections with unrelated articles)
 *     - Slug pattern: ^[0-9a-f]{12}$
 *  2. Per article: GET /_api/news/{slug} JSON API
 *     - headline, content (HTML cleaned to text), published_at (Bengali AM/PM),
 *       image.thumb URL (/images/storage/ -> /storage/ fix),
 *       category.slug + category.name, tag[].name
 *  - Date cutoff: article_dt <= cutoff_dt -> skip (uses <=)
 *  - First run cutoff: today at 00:00:00
 *  - Stops after 5 consecutive old/skip articles
 *  - NO pagination (single category page per cycle)
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
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'amadershomoy.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'amadershomoy');
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
const BASE_URL    = 'https://www.dainikamadershomoy.com';
const API_URL     = 'https://www.dainikamadershomoy.com/api';
const BASE_DOMAIN = 'amadershomoy';

const MAX_CONSECUTIVE_OLD = 5;
const SLUG_PATTERN = /^[0-9a-f]{10,16}$/;

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// -- Tiny helpers ------------------------------------------------------------
function log(msg)  { process.stdout.write(String(msg) + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)   { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function todayAtMidnight() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} 00:00:00`;
}

function randomUA() {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ];
  return UAS[Math.floor(Math.random() * UAS.length)];
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
    'User-Agent':                randomUA(),
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':           'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':           'gzip, deflate',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };
}

// -- Cycle time --------------------------------------------------------------
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['amadershomoy'];
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

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories WHERE site='amadershomoy' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='amadershomoy'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) { return 1; }
}

// -- Headline dedup map -------------------------------------------------------
const HEADLINE_TO_ID = {};

async function loadHeadlineMap() {
  const [rows] = await getPool().execute(
    `SELECT id, actual_headline FROM articles WHERE actual_headline IS NOT NULL AND actual_headline != ''`);
  for (const r of rows) HEADLINE_TO_ID[r.actual_headline] = r.id;
}

// -- Image folder ------------------------------------------------------------
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl, slug) {
  if (!imageUrl) return null;
  try {
    // Fix: /images/storage/ -> /storage/ (admin CDN URL quirk)
    if (imageUrl.includes('/images/storage/')) {
      imageUrl = imageUrl.replace('/images/storage/', '/storage/');
    }
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    if (imageUrl.startsWith('data:')) return null;

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent':    randomUA(),
        'Accept':        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer':       BASE_URL + '/',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const fname = `${slug}_main.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded image: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Bengali date parser -----------------------------------------------------
// Input: "১৮ ফেব্রুয়ারি ২০২৬, ১১:৩৮ এএম"
// Output: "2026-02-18T11:38:00"
const BN_MONTHS = {
  'জানুয়ারি': 1, 'ফেব্রুয়ারি': 2, 'মার্চ': 3, 'এপ্রিল': 4,
  'মে': 5, 'জুন': 6, 'জুলাই': 7, 'আগস্ট': 8,
  'সেপ্টেম্বর': 9, 'অক্টোবর': 10, 'নভেম্বর': 11, 'ডিসেম্বর': 12,
};
const BN_DIGITS = str => str.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));

function parseBengaliDatetime(raw) {
  if (!raw) return null;
  try {
    const s = BN_DIGITS(raw.trim());
    // Pattern: "DD Month YYYY, HH:MM AM/PM"
    const m = s.match(/^(\d+)\s+(\S+)\s+(\d+),\s+(\d+):(\d+)\s+(\S+)/);
    if (!m) return null;

    const day    = parseInt(m[1], 10);
    const month  = BN_MONTHS[m[2]];
    const year   = parseInt(m[3], 10);
    let   hour   = parseInt(m[4], 10);
    const min    = parseInt(m[5], 10);
    const ampm   = m[6];

    if (!month) return null;

    if (ampm.includes('পিএম') || ampm.includes('PM')) {
      if (hour !== 12) hour += 12;
    } else if (ampm.includes('এএম') || ampm.includes('AM')) {
      if (hour === 12) hour = 0;
    }

    return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:00`;
  } catch (_) {
    return null;
  }
}

// -- HTML content cleaner ----------------------------------------------------
// Removes img/script/style tags, extracts <p> text (like Python clean_html_content)
function cleanHtmlContent(html) {
  if (!html) return '';
  try {
    const $ = cheerio.load(html);
    $('img, script, style').remove();
    const parts = [];
    $('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) parts.push(t);
    });
    return parts.length ? parts.join('\n\n') : $.root().text().trim();
  } catch (_) {
    return html;
  }
}

// -- Extract slugs from category page ----------------------------------------
// Parses __NUXT_DATA__ JSON array, follows category_all_news references only
async function extractSlugsFromCategoryPage(categoryUrl) {
  try {
    const resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 20000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return [];

    const $ = cheerio.load(resp.data);
    const nuxtScript = $('script#__NUXT_DATA__').html();
    if (!nuxtScript) {
      log('   [WARN] __NUXT_DATA__ script not found');
      return [];
    }

    const data = JSON.parse(nuxtScript);

    // Step 1: find root state dict containing category_all_news
    let rootState = null;
    for (const item of data) {
      if (item && typeof item === 'object' && !Array.isArray(item) && 'category_all_news' in item) {
        rootState = item;
        break;
      }
    }
    if (!rootState) {
      log('   [WARN] category_all_news key not found in NUXT data');
      return [];
    }

    // Step 2: follow category_all_news -> list of article object indices
    const catIdx = rootState['category_all_news'];
    if (catIdx == null || !Array.isArray(data[catIdx])) {
      log('   [WARN] category_all_news does not point to an array');
      return [];
    }
    const articleObjIndices = data[catIdx];

    // Step 3: resolve slug for each article object
    const slugs = [];
    const seen  = new Set();
    for (const objIdx of articleObjIndices) {
      if (typeof objIdx !== 'number' || objIdx >= data.length) continue;
      const artObj = data[objIdx];
      if (!artObj || typeof artObj !== 'object' || !('slug' in artObj)) continue;
      const slugRef = artObj['slug'];
      if (typeof slugRef !== 'number' || slugRef >= data.length) continue;
      const slug = data[slugRef];
      if (typeof slug === 'string' && SLUG_PATTERN.test(slug) && !seen.has(slug)) {
        slugs.push(slug);
        seen.add(slug);
      }
    }

    return slugs;
  } catch (e) {
    log(`   [ERROR] extractSlugsFromCategoryPage: ${String(e.message).substring(0, 100)}`);
    return [];
  }
}

// -- Fetch article from API --------------------------------------------------
async function fetchArticleFromApi(slug) {
  try {
    const resp = await retryWithBackoff(() => axios.get(`${API_URL}/news/${slug}`, {
      timeout: 15000,
      headers: { 'User-Agent': randomUA(), 'Accept': 'application/json' },
    }));
    if (resp.status !== 200) return null;
    const json = resp.data;
    if (json && json.data) return json.data;
    return null;
  } catch (e) {
    log(`   [WARN] API fetch failed for ${slug}: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Process one article -----------------------------------------------------
async function processArticle(slug, cutoffStr, categorySlug, sectionLabel) {
  const articleUrl = `${BASE_URL}/details/${slug}`;

  // Already in DB?
  if (await urlExists(articleUrl)) {
    log('  [SKIP] Already in database');
    return false;
  }

  // Fetch from API
  const data = await fetchArticleFromApi(slug);
  if (!data) {
    log('  [ERROR] Could not fetch article data');
    return false;
  }

  const headline      = data.headline || '';
  const contentHtml   = data.content  || '';
  const bengaliDate   = data.published_at || '';
  const imageData     = data.image    || {};
  const categoryData  = data.category || {};
  const tagsData      = Array.isArray(data.tag) ? data.tag : [];

  if (!headline || !bengaliDate) {
    log('  [ERROR] Missing required fields (headline or date)');
    return false;
  }

  // Parse datetime
  const isoDate = parseBengaliDatetime(bengaliDate);
  if (!isoDate) {
    log(`  [ERROR] Could not parse datetime: ${bengaliDate}`);
    return false;
  }

  log(`  Published: ${isoDate}`);

  // Date cutoff check (article_dt <= cutoff_dt -> skip)
  if (cutoffStr) {
    const articleDt = new Date(isoDate.replace('T', ' '));
    const cutoffDt  = new Date(cutoffStr.replace('T', ' '));
    if (articleDt <= cutoffDt) {
      log(`  [SKIP] Article ${isoDate} <= cutoff ${cutoffStr}`);
      return false;
    }
  }

  // Resolve category from API response or fall back to DB value
  const resolvedCategory = (categoryData && categoryData.slug) ? categoryData.slug : categorySlug;
  const resolvedSection  = (categoryData && categoryData.name) ? categoryData.name  : sectionLabel;

  // Tags
  const tags = tagsData
    .filter(t => t && typeof t === 'object' && t.name)
    .map(t => t.name)
    .join(',');

  // Image URL (fix /images/storage/ -> /storage/)
  let imageUrl = '';
  if (typeof imageData === 'object' && imageData !== null) {
    imageUrl = imageData.thumb || '';
  } else if (typeof imageData === 'string') {
    imageUrl = imageData;
  }
  log(`  Image URL: ${imageUrl ? imageUrl.substring(0, 100) : 'None'}`);

  // Clean content
  const content = cleanHtmlContent(contentHtml);

  // Headline dedup
  const existingId = HEADLINE_TO_ID[headline];
  if (existingId) {
    log(`  [SKIP] Duplicate headline (id ${existingId})`);
    return false;
  }

  // Download image
  const imageName = imageUrl ? await downloadImage(imageUrl, slug) : null;
  if (imageName) log(`  Main image saved: ${imageName}`);

  // Insert into DB
  try {
    const newId = await insertArticle({
      headline,
      isoDate,
      content,
      imageName,
      url:      articleUrl,
      tags,
      category: resolvedCategory,
      section:  resolvedSection,
    });
    if (newId) {
      HEADLINE_TO_ID[headline] = newId;
      log(`[OK] Inserted new article (ID: ${newId})`);
      return true;
    }
    log('  [ERROR] Database insertion failed');
    return false;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      log('  Article already exists in DB (duplicate URL)');
    } else {
      log(`  [ERROR] Database error: ${String(e.message).substring(0, 100)}`);
    }
    return false;
  }
}

// -- Main loop ---------------------------------------------------------------
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(60));
  log('DAINIKAMADERSHOMOY.COM SCRAPER - MySQL Version');
  log('='.repeat(60));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(60));

  ensureImgFolder();

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
      log('No active AmaderShomoy categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active AmaderShomoy categories`);

    const cycleStart = Date.now();
    log(`\n${'='.repeat(60)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(60) + '\n');

    let totalNew = 0;

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      log(`\n${'='.repeat(60)}`);
      log(`SECTION: ${sectionLabel}`);
      log(`URL: ${categoryUrl}`);

      // Category slug from URL last segment
      const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop() || 'general';
      log(`Category: ${categorySlug}`);
      log('='.repeat(60));
      log(`[STATUS:finding:Searching ${sectionLabel}]`);

      // Capture start timestamp before extraction
      const sectionStartTimestamp = nowStr();

      const lastCutoff = lastProcessedDates[sectionLabel];
      let cutoffStr;
      if (lastCutoff) {
        cutoffStr = lastCutoff.replace('T', ' ');
        log(`Last processed: ${lastCutoff}`);
      } else {
        cutoffStr = todayAtMidnight();
        log(`First run - processing articles since: ${cutoffStr}`);
      }

      // Extract slugs from NUXT data
      log('\nExtracting article slugs from category page...');
      const slugs = await extractSlugsFromCategoryPage(categoryUrl);

      if (!slugs.length) {
        log('  No articles found');
        continue;
      }
      log(`  Found ${slugs.length} articles`);

      let newCount       = 0;
      let consecutiveOld = 0;

      for (let idx = 0; idx < slugs.length; idx++) {
        const slug       = slugs[idx];
        const articleUrl = `${BASE_URL}/details/${slug}`;
        log(`\n[${idx+1}/${slugs.length}] ${articleUrl}`);
        log(`[STATUS:extracting:${newCount}]`);

        const ok = await processArticle(slug, cutoffStr, categorySlug, sectionLabel);

        if (ok) {
          newCount++;
          totalNew++;
          consecutiveOld = 0;
        } else {
          consecutiveOld++;
          if (consecutiveOld >= MAX_CONSECUTIVE_OLD) {
            log(`\n  [INFO] ${consecutiveOld} consecutive old/duplicate articles - stopping early`);
            break;
          }
        }

        await sleep(500);
      }

      log(`\n  Added ${newCount} new articles from ${sectionLabel}`);

      // Save section start timestamp (not end) to avoid missing articles published during processing
      lastProcessedDates[sectionLabel] = sectionStartTimestamp;
      saveLastProcessedDates(lastProcessedDates);
      log(`  Last processed timestamp saved: ${sectionStartTimestamp}`);
    }

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
