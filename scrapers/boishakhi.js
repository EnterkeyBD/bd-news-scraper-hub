#!/usr/bin/env node
'use strict';

/**
 * Boishakhi TV Scraper - Node.js
 * Ported from boishakhi-scraper/scrapboishakhi_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Architecture:
 *  - Category pages are single-page (no pagination / infinite scroll via API)
 *  - Article links matched by: /{category_slug}/{numeric_id} (last segment is a number)
 *  - Cross-category filter: URL must contain /{expected_category}/{id}
 *  - Link discovery: div.common-card-content a + div[class*="col-"] a
 *  - Date: div.entry_update text containing "প্রকাশ" — Bengali date
 *          Format: "বৃহস্পতিবার, ১৯ ফেব্রুয়ারি ২০২৬" or "১৯ ফেব্রুয়ারি ২০২৬, ১০:৪১ এএম"
 *          Fallback: any div/span/p containing Bengali day name
 *  - Timestamp window: last_dt < article_dt <= cycle_start_dt (Dhaka TZ aware)
 *  - First run: today-only (Dhaka timezone date match)
 *  - Content: div.dtl_content_section -> <p> tags (>30 chars)
 *  - Image: div.dtl_img_section img[src]; fallback og:image
 *           Fixes duplicated domain bug: "https://boishakhionline.comhttps://..."
 *  - Tags: meta[name="keywords"] content
 *  - Image filename: boishakhi_{articleId}.jpg  (article URL's numeric tail)
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
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'boishakhi.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'boishakhi');
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
const BASE_URL    = 'https://boishakhionline.com';
const BASE_DOMAIN = 'boishakhi';
// Dhaka UTC offset: +06:00
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Bengali digit / month maps
const BN_DIGITS = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };
const BN_MONTHS = {
  'জানুয়ারি':1,'ফেব্রুয়ারি':2,'মার্চ':3,'এপ্রিল':4,
  'মে':5,'জুন':6,'জুলাই':7,'আগস্ট':8,
  'সেপ্টেম্বর':9,'অক্টোবর':10,'নভেম্বর':11,'ডিসেম্বর':12,
};
const BN_DAYS = ['সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার','রবিবার'];

// -- Tiny helpers ------------------------------------------------------------
function log(msg)  { process.stdout.write(String(msg) + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)   { return String(n).padStart(2, '0'); }

// Dhaka "now" as a plain Date (wall-clock in Dhaka timezone stored as UTC Date)
function dhakaDate(d) {
  // d is a JS Date (UTC). Return new Date adjusted to Dhaka local time.
  return new Date(d.getTime() + DHAKA_OFFSET_MS);
}
function dhakaLocalNow() { return dhakaDate(new Date()); }

function nowStr() {
  const d = dhakaLocalNow();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function todayDateStr() {
  const d = dhakaLocalNow();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
}

// Convert Bengali digits to ASCII
function bnToEn(s) {
  return [...String(s)].map(c => BN_DIGITS[c] !== undefined ? BN_DIGITS[c] : c).join('');
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
    const v = cfg['boishakhi'];
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
    `SELECT category_url, section_label FROM categories WHERE site='boishakhi' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='boishakhi'`);
    return rows[0] ? rows[0].autorun : 1;
  } catch (_) { return 1; }
}

// -- Image folder ------------------------------------------------------------
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl, articleNumericId) {
  if (!imageUrl) return null;
  try {
    // Fix duplicated domain bug
    if (imageUrl.includes('boishakhionline.comhttps://')) {
      imageUrl = imageUrl.replace('https://boishakhionline.comhttps://', 'https://');
    }
    if (imageUrl.startsWith('//'))                        imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/boishakhionline.com/')) imageUrl = 'https:/' + imageUrl;
    else if (imageUrl.startsWith('/'))                    imageUrl = BASE_URL + imageUrl;
    else if (!imageUrl.startsWith('http')) {
      imageUrl = imageUrl.startsWith('boishakhionline.com')
        ? 'https://' + imageUrl
        : BASE_URL + '/' + imageUrl;
    }

    const resp = await retryWithBackoff(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer':    BASE_URL + '/',
      },
    }));
    if (resp.status !== 200) return null;

    // Sanity-check: at least 1KB
    if (resp.data.length < 1000) {
      log(`   [WARN] Image too small (${resp.data.length} bytes) — skipping`);
      return null;
    }

    ensureImgFolder();
    const fname = `boishakhi_${articleNumericId}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Image saved: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// -- Bengali date parser -----------------------------------------------------
// Formats:
//   "বৃহস্পতিবার, ১৯ ফেব্রুয়ারি ২০২৬"                  (day name, no time)
//   "১৯ ফেব্রুয়ারি ২০২৬, ১০:৪১ এএম"                     (no day name, with time)
//   "বৃহস্পতিবার, ১৯ ফেব্রুয়ারি ২০২৬, ১০:৪১ এএম"        (day name and time)
// Returns a Date object whose UTC time represents Dhaka wall-clock time,
// i.e.  new Date(dhakaWallClock - 6h * 3600000)   so comparisons work.
function parseBengaliDate(raw) {
  if (!raw) return null;
  try {
    let s = raw.trim();

    // Strip leading day name (any of the 7 Bengali day names)
    for (const day of BN_DAYS) {
      if (s.startsWith(day)) { s = s.slice(day.length).replace(/^,\s*/, '').trim(); break; }
    }

    // Try to extract time (HH:MM এএম/পিএম)
    let hour = 0, minute = 0;
    const timeMatch = s.match(/(\d+):(\d+)\s*(এএম|পিএম)/);
    if (timeMatch) {
      hour   = parseInt(bnToEn(timeMatch[1]), 10);
      minute = parseInt(bnToEn(timeMatch[2]), 10);
      const isPM = timeMatch[3] === 'পিএম';
      if (isPM && hour !== 12) hour += 12;
      if (!isPM && hour === 12) hour = 0;
      // Remove time part from string
      s = s.replace(/,?\s*\d+:\d+\s*(এএম|পিএম)/, '').trim().replace(/,\s*$/, '').trim();
    }

    // Convert remaining Bengali digits
    s = bnToEn(s).trim();

    // Now parse "DD MonthName YYYY"
    const parts = s.split(/\s+/);
    if (parts.length < 3) return null;
    const day   = parseInt(parts[0], 10);
    const month = BN_MONTHS[parts[1]] || BN_MONTHS[Object.keys(BN_MONTHS).find(k => bnToEn(k) === parts[1])];
    const year  = parseInt(parts[2], 10);
    if (!day || !month || !year) return null;

    // Build a UTC Date that represents this Dhaka local time
    // Dhaka is UTC+6; to store "Dhaka local" we subtract 6h from UTC
    // But for comparison purposes we simply create the Date as UTC equivalent
    // (same as Python's DHAKA_TZ.localize(datetime(...)) stored in JS)
    // UTC = DhakaLocal - 6h
    const utcMs = Date.UTC(year, month - 1, day, hour - 6, minute, 0);
    const dt = new Date(utcMs);
    return isNaN(dt) ? null : dt;
  } catch (_) { return null; }
}

// -- Fetch and parse article page --------------------------------------------
async function fetchArticle(url) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 20000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Headline
    const headline = $('h1').first().text().trim();
    if (!headline || headline.length < 3) return null;

    // Date — try div.entry_update first
    let publishedAt = null;
    const entryUpdate = $('div.entry_update');
    if (entryUpdate.length) {
      const lines = entryUpdate.text().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('প্রকাশ') || t.includes('প্রকাশ :') || t.includes('প্রকাশঃ')) {
          const cleaned = t.replace(/প্রকাশ\s*[:ঃ]/g, '').trim();
          publishedAt = parseBengaliDate(cleaned);
          if (publishedAt) break;
        }
      }
    }

    // Fallback: div.col-md-5
    if (!publishedAt) {
      const col = $('div.col-md-5').first();
      if (col.length) {
        const lines = col.text().split('\n');
        for (const line of lines) {
          const t = line.trim();
          if (t.includes('প্রকাশ') || BN_DAYS.some(d => t.includes(d)) ||
              Object.keys(BN_MONTHS).some(m => t.includes(m))) {
            const cleaned = t.replace(/প্রকাশ\s*[:ঃ]/g, '').trim();
            publishedAt = parseBengaliDate(cleaned);
            if (publishedAt) break;
          }
        }
      }
    }

    // Fallback: any div/span/p with a Bengali day name
    if (!publishedAt) {
      $('div, span, small, p').each((_, el) => {
        if (publishedAt) return;
        const t = $(el).text().trim();
        if (BN_DAYS.some(d => t.includes(d))) {
          publishedAt = parseBengaliDate(t);
        }
      });
    }

    // Content: div.dtl_content_section -> <p> (>30 chars)
    let parts = [];
    const contentDiv = $('div.dtl_content_section').first();
    if (contentDiv.length) {
      contentDiv.find('p').each((_, p) => {
        const t = $(p).text().trim();
        if (t && t.length > 30) parts.push(t);
      });
    }
    const content = parts.join(' ');
    if (!content || content.length < 50) {
      log('  [SKIP] Insufficient content');
      return null;
    }

    // Image: div.dtl_img_section img; fallback og:image
    let imageUrl = '';
    const dtlImg = $('div.dtl_img_section').first();
    if (dtlImg.length) {
      const img = dtlImg.find('img').first();
      imageUrl = img.attr('src') || img.attr('data-src') || '';
    }
    if (!imageUrl) {
      imageUrl = $('meta[property="og:image"]').attr('content') || '';
    }
    imageUrl = imageUrl.trim();

    // Tags: meta[name="keywords"]
    const tags = $('meta[name="keywords"]').attr('content') || '';

    return { publishedAt, headline, content, imageUrl: imageUrl || null, tags };
  } catch (e) {
    log(`  [ERROR] fetchArticle ${url}: ${String(e.message).substring(0, 80)}`);
    return null;
  }
}

// -- Collect article links from category page --------------------------------
function extractLinks($, categorySlug) {
  const seen  = new Set();
  const links = [];

  function addLink(href) {
    if (!href) return;
    if (href.startsWith('//'))     href = 'https:' + href;
    else if (href.startsWith('/')) href = BASE_URL + href;
    if (!href.startsWith('http')) return;

    // Last segment must be a pure integer (article ID)
    const parts = href.replace(/\/$/, '').split('/');
    const lastSeg = parts[parts.length - 1];
    if (!/^\d+$/.test(lastSeg)) return;

    // Second-to-last segment must match expected category
    const catSeg = parts[parts.length - 2];
    if (catSeg !== categorySlug) return;

    if (!seen.has(href)) { seen.add(href); links.push(href); }
  }

  // Method 1: div.common-card-content a
  $('div.common-card-content').find('a[href]').each((_, el) => addLink($(el).attr('href')));

  // Method 2: div[class*="col-"] a
  $('div').filter((_, el) => {
    const cls = $(el).attr('class') || '';
    return cls.split(/\s+/).some(c => c.startsWith('col-'));
  }).find('a[href]').each((_, el) => addLink($(el).attr('href')));

  return links;
}

// -- Process one article -----------------------------------------------------
async function processArticle(url, cutoffDt, cycleStartDt, sectionLabel, category) {
  if (await urlExists(url)) {
    log('  [SKIP] Already in database');
    return false;
  }

  const data = await fetchArticle(url);
  if (!data) { log('  [ERROR] Could not fetch article'); return false; }

  const { publishedAt, headline, content, imageUrl, tags } = data;

  if (cutoffDt && cycleStartDt && publishedAt) {
    if (publishedAt <= cutoffDt) {
      log(`  [SKIP] Too old: ${publishedAt.toISOString()}`);
      return false;
    }
    if (publishedAt > cycleStartDt) {
      log(`  [SKIP] Too new: ${publishedAt.toISOString()}`);
      return false;
    }
  } else if (!cutoffDt && publishedAt) {
    // First run: today-only (Dhaka date)
    const artDhaka = dhakaDate(publishedAt);
    const artDateStr = `${artDhaka.getUTCFullYear()}-${pad2(artDhaka.getUTCMonth()+1)}-${pad2(artDhaka.getUTCDate())}`;
    if (artDateStr !== todayDateStr()) {
      log(`  [SKIP] Not today (Dhaka): ${artDateStr}`);
      return false;
    }
  }

  if (publishedAt) log(`  Published: ${publishedAt.toISOString()}`);

  // Numeric tail of URL is the image filename ID
  const numericId = url.replace(/\/$/, '').split('/').pop();
  const imageName = imageUrl ? await downloadImage(imageUrl, numericId) : null;

  try {
    const newId = await insertArticle({
      headline,
      isoDate:  publishedAt ? publishedAt.toISOString() : null,
      content,
      imageName,
      url,
      tags,
      category: category || sectionLabel,
      section:  sectionLabel,
    });
    if (!newId) { log('  [ERROR] DB insertion failed'); return false; }
    log(`[OK] Inserted new article (ID: ${newId})`);
    return true;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') { log('  Article already exists (duplicate URL)'); return false; }
    log(`  [ERROR] DB: ${String(e.message).substring(0, 100)}`);
    return false;
  }
}

// -- Process one category ----------------------------------------------------
async function processCategory(categoryUrl, sectionLabel, category, lastTimestamp) {
  log(`\n${'='.repeat(70)}`);
  log(`Processing: ${sectionLabel}`);
  log('='.repeat(70));
  log(`[STATUS:finding:Searching ${sectionLabel}]`);

  const cycleStartTimestamp = nowStr();

  const categorySlug = categoryUrl.replace(/\/$/, '').split('/').pop();

  // Build cutoff / cycle-start datetimes (stored as UTC representing Dhaka local)
  let cutoffDt    = null;
  let cycleStartDt = null;
  if (lastTimestamp) {
    // lastTimestamp is "YYYY-MM-DD HH:MM:SS" in Dhaka local time
    // Convert to UTC by subtracting 6h
    cutoffDt    = new Date(new Date(lastTimestamp.replace(' ', 'T') + '+06:00').getTime());
    cycleStartDt = new Date(new Date(cycleStartTimestamp.replace(' ', 'T') + '+06:00').getTime());
    log(`Cutoff: ${lastTimestamp}  →  Cycle start: ${cycleStartTimestamp}`);
  } else {
    log(`First run — today only (Dhaka date: ${todayDateStr()})`);
  }

  // Fetch category page
  let resp;
  try {
    resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 20000,
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
  const links = extractLinks($, categorySlug);
  log(`Found ${links.length} article links for '${categorySlug}'`);

  let newCount = 0;
  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    log(`\n[${i+1}/${links.length}] ${url}`);
    log(`[STATUS:extracting:${newCount}]`);

    const ok = await processArticle(url, cutoffDt, cycleStartDt, sectionLabel, category);
    if (ok) newCount++;

    await sleep(500);
  }

  log(`\nCompleted: ${newCount}/${links.length} articles processed`);
  return { newCount, cycleStartTimestamp };
}

// -- Main loop ---------------------------------------------------------------
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('BOISHAKHI TV NEWS SCRAPER - MySQL Version');
  log('='.repeat(70));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log(`Site: ${BASE_URL}`);
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
      log('No active Boishakhi categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nFound ${categories.length} active categories`);

    const cycleStart = Date.now();
    log(`\n${'#'.repeat(70)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('#'.repeat(70));

    let totalNew = 0;
    const updatedDates = { ...lastProcessedDates };

    for (const { category_url: categoryUrl, section_label: sectionLabel, category } of categories) {
      const lastTimestamp = lastProcessedDates[sectionLabel] || null;

      const { newCount, cycleStartTimestamp } = await processCategory(
        categoryUrl, sectionLabel, category || sectionLabel, lastTimestamp);

      totalNew += newCount;
      updatedDates[sectionLabel] = cycleStartTimestamp;

      await sleep(2000);
    }

    saveLastProcessedDates(updatedDates);
    lastProcessedDates = updatedDates;

    log(`\n${'='.repeat(70)}`);
    log(`CYCLE COMPLETED — ${totalNew} new articles added`);
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
