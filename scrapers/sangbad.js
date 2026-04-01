#!/usr/bin/env node
'use strict';

/**
 * Sangbad Scraper – Node.js
 * Ported from sangbad-scraper/scrapsangbad_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active sangbad categories from MySQL
 *  - NO pagination — single category page only
 *  - Article URL pattern: /news/{id} (e.g. https://sangbad.net/news/12345)
 *  - Date extraction: full-page text regex for Bengali weekday+date
 *      "মঙ্গলবার, ১৭ ফেব্রুয়ারী ২০২৬" → "2026-02-17T00:00:00"
 *      No time component — sangbad dates are date-only
 *  - Date cutoff: DATE-ONLY comparison (article_date < cutoff_date)
 *      Last-processed file stores "YYYY-MM-DD" strings (no time)
 *      First run: today's date (articles strictly older than today are skipped)
 *      Stops after 5 consecutive old articles
 *  - Article scraping:
 *      headline: <h1> → <h2 class="title">
 *      date:     page-text Bengali regex → convertToIso8601()
 *      content:  all <p> tags with text > 30 chars, joined \n
 *      image:    meta[property="og:image"] (most reliable, article-specific)
 *                → article container (div.news-details / div.details / article)
 *                  img matching /images/{date}/main_image/ path - NEVER whole-doc search
 *      tags:     div.tags a → div.article-tags a
 *  - Exponential back-off on connection errors (3 attempts: 2s, 4s)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] tokens parsed by server.js
 *  - Emits [OK] Inserted new article (ID: X) for server.js article counting
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// ── Paths ───────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'sangbad.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'sangbad');
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
const BASE_URL    = 'https://sangbad.net';
const BASE_DOMAIN = 'sangbad.net';

const MAX_CONSECUTIVE_OLD = 5;

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// ── Tiny helpers ─────────────────────────────────────────────────────────────
function log(msg)   { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function pad2(n)    { return String(n).padStart(2, '0'); }

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function randomUA() {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ];
  return UAS[Math.floor(Math.random() * UAS.length)];
}

// ── Retry with exponential back-off ─────────────────────────────────────────
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
      const delay = (attempt + 1) * 2000; // 2s, 4s (matches Python: 2, 4, 6)
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
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { 'Referer': referer } : {}),
  };
}

// ── Cycle time ───────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['sangbad'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// ── Last-processed dates ─────────────────────────────────────────────────────
// Sangbad stores DATE-ONLY strings "YYYY-MM-DD" (no time component)
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
    `SELECT category_url, section_label FROM categories WHERE site='sangbad' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='sangbad'`);
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
        'User-Agent':     randomUA(),
        'Accept':         'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer':        BASE_URL + '/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `sangbad_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded image: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// ── Bengali date converter ───────────────────────────────────────────────────
// Input: Bengali weekday+date text e.g. "মঙ্গলবার, ১৭ ফেব্রুয়ারী ২০২৬"
// Output: "2026-02-17T00:00:00" (no time component on sangbad)
const BN_DIGITS = str => str.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));

const BN_MONTH_MAP = {
  'জানুয়ারি':  1, 'জানুয়ারী':  1,
  'ফেব্রুয়ারি': 2, 'ফেব্রুয়ারী': 2,
  'মার্চ':      3,
  'এপ্রিল':    4, 'এপ্রিলে':   4,
  'মে':        5,
  'জুন':       6,
  'জুলাই':     7,
  'আগস্ট':     8,
  'সেপ্টেম্বর': 9,
  'অক্টোবর':  10,
  'নভেম্বর':  11,
  'ডিসেম্বর': 12,
};

const EN_MONTHS = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];

function convertToIso8601(dateText) {
  if (!dateText) return null;
  try {
    // Convert Bengali digits
    let s = BN_DIGITS(dateText);

    // Replace Bengali month names with English equivalents
    for (const [bn, num] of Object.entries(BN_MONTH_MAP)) {
      if (s.includes(bn)) {
        s = s.replace(bn, EN_MONTHS[num - 1]);
        break;
      }
    }

    // Strip Bengali day-of-week names and commas
    // Python: re.sub(r'[সোমঙ্গলবুধবৃহশুক্রশনিরবিবার]+,?\s*', '', ...)
    s = s.replace(/[\u09b8\u09cb\u09ae\u0999\u09cd\u0997\u09b2\u09ac\u09c1\u09a7\u09ac\u09c3\u09b9\u09b6\u09c1\u0995\u09cd\u09b0\u09b6\u09a8\u09bf\u09b0\u09ac\u09bf]+,?\s*/g, '');
    s = s.replace(/,/g, '').trim();

    // Extract: "17 February 2026"
    const m = s.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (m) {
      const d   = parseInt(m[1], 10);
      const mon = EN_MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) + 1;
      const y   = parseInt(m[3], 10);
      return `${y}-${pad2(mon)}-${pad2(d)}T00:00:00`;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── Extract date from full page text (Bengali day regex) ─────────────────────
// Pattern mirrors Python:
// r'[সোমঙ্গলবুধবৃহশুক্রশনিরবিবার]+,?\s*[০-৯\d]+\s+[জফমএমজজআসঅনডি]+[^\n]{0,50}?[০-৯\d]{4}'
const BN_DATE_PATTERN = /[\u09b8\u09cb\u09ae\u0999\u09cd\u0997\u09b2\u09ac\u09c1\u09a7\u09ac\u09c3\u09b9\u09b6\u09c1\u0995\u09cd\u09b0\u09b6\u09a8\u09bf\u09b0\u09ac\u09bf]+,?\s*[\u09e6-\u09ef\d]+\s+[\u099c\u09ab\u09ae\u098f\u09ae\u099c\u099c\u0986\u09b8\u0985\u09a8\u09a1\u09bf][^\n]{0,50}?[\u09e6-\u09ef\d]{4}/;

function extractDateFromPageText(pageText) {
  const m = pageText.match(BN_DATE_PATTERN);
  return m ? m[0] : null;
}

// ── Extract article links from category page ──────────────────────────────────
// New URL pattern: /news/{id}  e.g. https://sangbad.net/news/12345
const ARTICLE_URL_RE = /\/news\/\d+\/?$/;

function extractArticleLinks(html) {
  const $ = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    if (!ARTICLE_URL_RE.test(href)) return;
    // Reject absolute URLs pointing to other domains
    if (href.startsWith('http') && !href.includes('sangbad.net')) return;
    const full = href.startsWith('http') ? href : BASE_URL + href;
    // Normalise trailing slash
    const norm = full.replace(/\/$/, '') + '/';
    if (!seen.has(norm)) { seen.add(norm); links.push(norm); }
  });

  return links;
}

// ── Category slug from URL ────────────────────────────────────────────────────
// https://sangbad.net/International/ → "international"
// The category slug is the last non-empty path segment (lowercased)
function categorySlugFromUrl(categoryUrl) {
  const last = categoryUrl.replace(/\/$/, '').split('/').filter(Boolean).pop();
  return last ? last.toLowerCase() : 'national';
}

// ── Scrape one article ────────────────────────────────────────────────────────
// Returns: { headline, isoDate, content, imageName, tags } | { isOld: true, isoDate } | null
async function scrapeArticle(url, cutoffDateStr) {
  try {
    const resp = await retryWithBackoff(() => axios.get(url, {
      timeout: 15000,
      headers: browserHeaders(BASE_URL + '/'),
    }));
    if (resp.status !== 200) return null;

    const html  = resp.data;
    const $     = cheerio.load(html);
    const pageText = $.root().text();

    // ── Date extraction ──────────────────────────────────────────────────────
    const rawDate  = extractDateFromPageText(pageText);
    const isoDate  = rawDate ? convertToIso8601(rawDate) : null;

    // Date cutoff check (DATE-ONLY, strict <)
    if (cutoffDateStr && isoDate) {
      const articleDate = isoDate.substring(0, 10); // "YYYY-MM-DD"
      if (articleDate < cutoffDateStr) {
        log(`   → Date ${articleDate} is before cutoff ${cutoffDateStr}`);
        return { isOld: true, isoDate };
      }
    }

    // ── Headline ─────────────────────────────────────────────────────────────
    const headline = $('h1').first().text().trim()
      || $('h2.title').first().text().trim()
      || 'No headline';

    // ── Content ──────────────────────────────────────────────────────────────
    const parts = [];
    $('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 30) parts.push(t);
    });
    const content = parts.join('\n');

    // ── Image ─────────────────────────────────────────────────────────────────
    // Strategy 1: og:image (always article-specific — most reliable)
    let imageUrl = $('meta[property="og:image"]').attr('content') || '';

    // Strategy 2: article container only — never whole-doc (sidebars also contain main_image imgs)
    if (!imageUrl) {
      const container = $('div.news-details').first().length ? $('div.news-details').first()
        : $('div.details').first().length ? $('div.details').first()
        : $('article').first();

      if (container && container.length) {
        container.find('img').each((_, el) => {
          if (imageUrl) return;
          const src = $(el).attr('src') || $(el).attr('data-src') || '';
          if (/\/images\/.*\/main_image\//.test(src)) imageUrl = src;
        });
      }
    }

    const imageName = imageUrl ? await downloadImage(imageUrl) : null;

    // ── Tags ──────────────────────────────────────────────────────────────────
    const tagSet = new Set();
    const tagsDiv = $('div.tags').first().length ? $('div.tags').first()
      : $('div.article-tags').first();
    if (tagsDiv && tagsDiv.length) {
      tagsDiv.find('a').each((_, el) => {
        const t = $(el).text().trim();
        if (t) tagSet.add(t);
      });
    }
    const tags = tagSet.size ? Array.from(tagSet).join(', ') : '';

    return { headline, isoDate: isoDate || 'Not Available', content, imageName, tags };
  } catch (e) {
    log(`   [ERROR] scrapeArticle(${url.split('/').slice(-2).join('/')}): ${String(e.message).substring(0, 100)}`);
    return null;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(60));
  log('SANGBAD.NET NEWS SCRAPER - MySQL Version');
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
      log('No active Sangbad categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Sangbad categories`);

    const cycleStart = Date.now();
    log(`\n${'='.repeat(60)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(60) + '\n');

    let totalNew = 0;

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      log(`\n${'='.repeat(60)}`);
      log(`SECTION: ${sectionLabel}`);
      log(`URL: ${categoryUrl}`);
      log('='.repeat(60));
      log(`[STATUS:finding:Searching ${sectionLabel}]`);

      const categorySlug = categorySlugFromUrl(categoryUrl);

      // Date cutoff — DATE-ONLY strings
      const lastCutoff = lastProcessedDates[sectionLabel];
      let cutoffDateStr;
      if (lastCutoff) {
        cutoffDateStr = lastCutoff.substring(0, 10); // ensure "YYYY-MM-DD"
        log(`Last processed: ${lastCutoff}`);
      } else {
        cutoffDateStr = todayStr();
        log(`First run — processing only today's articles: ${cutoffDateStr}`);
      }

      // Fetch category page
      let articleLinks = [];
      try {
        const resp = await retryWithBackoff(() => axios.get(categoryUrl, {
          timeout: 15000,
          headers: browserHeaders(),
        }));
        if (resp.status === 200) {
          articleLinks = extractArticleLinks(resp.data);
          log(`  Found ${articleLinks.length} article links`);
        }
      } catch (e) {
        log(`  [ERROR] Category page fetch failed: ${String(e.message).substring(0, 80)}`);
      }

      if (!articleLinks.length) {
        log('  No articles found');
        continue;
      }

      log(`\n  Processing ${articleLinks.length} articles...`);

      let newCount           = 0;
      let consecutiveOld     = 0;

      for (let idx = 0; idx < articleLinks.length; idx++) {
        const url = articleLinks[idx];
        log(`\n[${idx+1}/${articleLinks.length}] ${url}`);
        log(`[STATUS:extracting:${newCount}]`);

        // Already in DB?
        if (await urlExists(url)) {
          log('  ⊘ Already in database');
          consecutiveOld = 0; // duplicate URL is not "old", reset per Python behaviour
          await sleep(500);
          continue;
        }

        const articleData = await scrapeArticle(url, cutoffDateStr);

        if (!articleData) {
          log('  ✗ Could not scrape article');
          await sleep(500);
          continue;
        }

        if (articleData.isOld) {
          consecutiveOld++;
          log(`  ⊘ Old article (consecutive: ${consecutiveOld}/${MAX_CONSECUTIVE_OLD})`);
          if (consecutiveOld >= MAX_CONSECUTIVE_OLD) {
            log(`\n  ✓ ${consecutiveOld} consecutive old articles — stopping early`);
            break;
          }
          await sleep(500);
          continue;
        }

        // Valid article — reset counter
        consecutiveOld = 0;

        // Headline dedup
        const { headline, isoDate, content, imageName, tags } = articleData;
        const existingId = HEADLINE_TO_ID[headline];
        if (existingId) {
          log(`  ⊘ Duplicate headline (id ${existingId})`);
          await sleep(500);
          continue;
        }

        try {
          const newId = await insertArticle({
            headline,
            isoDate,
            content,
            imageName,
            url,
            tags,
            category: categorySlug,
            section:  sectionLabel,
          });
          if (newId) {
            HEADLINE_TO_ID[headline] = newId;
            log(`[OK] Inserted new article (ID: ${newId})`);
            newCount++;
            totalNew++;
          }
        } catch (e) {
          if (e.code === 'ER_DUP_ENTRY') {
            log('  Article already exists in DB (duplicate URL)');
          } else {
            log(`  ✗ Database error: ${String(e.message).substring(0, 100)}`);
          }
        }

        await sleep(500);
      }

      log(`\n  Added ${newCount} new articles from ${sectionLabel}`);

      // Save date-only timestamp (matches Python: datetime.now().strftime("%Y-%m-%d"))
      lastProcessedDates[sectionLabel] = todayStr();
      saveLastProcessedDates(lastProcessedDates);
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
