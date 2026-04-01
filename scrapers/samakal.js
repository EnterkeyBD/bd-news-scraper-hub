#!/usr/bin/env node
'use strict';

/**
 * Samakal Scraper – Node.js
 * Ported from samakal-scraper/scrapsamakal_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active samakal categories from MySQL
 *  - Two-step pagination (requires session cookies from the initial GET —
 *    Laravel validates _token against the laravel_session cookie):
 *      1. Page 1: GET category_url  → a[href*="/article/"] links
 *         Also extracts CSRF token, input#catSlug, input#posCatID and Set-Cookie
 *      2. Next pages: POST /cat-load-more with slug/posCatIDs/page/_token
 *         Cookie header reuses session cookies captured from the GET response
 *         Response JSON {html:"..."} → parse for article links
 *      Stops when 4 consecutive already-in-DB / old-date articles found (max 10 pages)
 *  - Date extraction: div.dateAndTime Bengali text
 *      "প্রকাশ: ১৭ ফেব্রুয়ারি ২০২৬ | ০৫:৪৫" → "2026-02-17T05:45:00"
 *  - Article scraping:
 *      headline: <h1>
 *      date:     div.dateAndTime → parseBengaliDatetime()
 *      content:  div#contentDetails <p> (≥20 chars each), joined \n\n
 *      image:    meta[property="og:image"] → saved as samakal_{article_id}.jpg
 *      tags:     div.tagArea a text
 *  - Date cutoff: article_dt <= cutoff_dt → skip (uses <=, not <)
 *  - NO failed-URL retry (no insert_failed_url pattern in the Python original)
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
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'samakal.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'samakal');
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
const BASE_URL    = 'https://samakal.com';
const BASE_DOMAIN = 'samakal.com';
const LOAD_MORE_URL      = 'https://samakal.com/cat-load-more';
const MAX_PAGES          = 10;
const MAX_CONSECUTIVE_OLD = 4;

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

// ── AJAX/XHR headers ──────────────────────────────────────────────────────────
function ajaxHeaders(referer) {
  return {
    'User-Agent':                randomUA(),
    'Accept':                    '*/*',
    'Accept-Language':           'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Content-Type':              'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With':          'XMLHttpRequest',
    'Origin':                    BASE_URL,
    'Sec-Fetch-Dest':            'empty',
    'Sec-Fetch-Mode':            'cors',
    'Sec-Fetch-Site':            'same-origin',
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
    const v = cfg['samakal'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// ── Last-processed dates ─────────────────────────────────────────────────────
function loadLastProcessedDates() {
  try {
    if (fs.existsSync(LAST_PROC_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_PROC_FILE, 'utf8'));
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
    `SELECT category_url, section_label FROM categories WHERE site='samakal' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  try {
    const [rows] = await getPool().execute(
      `SELECT autorun FROM scraper_autorun WHERE site='samakal'`);
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

async function downloadImage(imageUrl, articleId) {
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
        'Referer':       BASE_URL + '/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    }));
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const fname = `samakal_${articleId}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`   [OK] Downloaded image: ${fname} (${(resp.data.length / 1024).toFixed(1)} KB)`);
    return fname;
  } catch (e) {
    log(`   [WARN] Image download failed: ${String(e.message).substring(0, 60)}`);
    return null;
  }
}

// ── Bengali date parser ──────────────────────────────────────────────────────
// Input: div.dateAndTime text e.g. "প্রকাশ: ১৭ ফেব্রুয়ারি ২০২৬ | ০৫:৪৫"
// Output: "2026-02-17T05:45:00"
const BN_MONTHS_NUM = {
  'জানুয়ারি': 1, 'ফেব্রুয়ারি': 2, 'মার্চ': 3,
  'এপ্রিল':   4, 'মে':         5, 'জুন':   6,
  'জুলাই':    7, 'আগস্ট':      8, 'সেপ্টেম্বর': 9,
  'অক্টোবর': 10, 'নভেম্বর':   11, 'ডিসেম্বর': 12,
};

const BN_DIGITS = str => str.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));

function parseBengaliDatetime(raw) {
  if (!raw) return null;
  try {
    // Convert Bengali digits to ASCII (month names stay Bengali)
    const s = BN_DIGITS(raw.trim());
    // Regex: \d+ day, Bengali-month, \d+ year, | HH:MM
    const m = s.match(/(\d+)\s+([^\s\d|]+)\s+(\d+)\s*\|\s*(\d+):(\d+)/);
    if (!m) return null;
    const day   = parseInt(m[1], 10);
    const month = BN_MONTHS_NUM[m[2].trim()];
    const year  = parseInt(m[3], 10);
    const hour  = parseInt(m[4], 10);
    const min   = parseInt(m[5], 10);
    if (!month) return null;
    return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:00`;
  } catch (_) {
    return null;
  }
}

// ── Article ID from URL ───────────────────────────────────────────────────────
function extractArticleId(url) {
  const m = url.match(/\/article\/(\d+)/);
  return m ? m[1] : Math.random().toString(36).substring(2, 12);
}

// ── Normalise article href → full URL ────────────────────────────────────────
function normaliseArticleHref(href) {
  if (!href) return null;
  if (href.startsWith('http')) {
    // Must be samakal.com domain and contain /article/
    try {
      const u = new URL(href);
      if (!u.hostname.endsWith('samakal.com')) return null;
      return u.origin + u.pathname;
    } catch (_) { return null; }
  }
  if (href.startsWith('/') && href.includes('/article/')) {
    return BASE_URL + href.split('?')[0];
  }
  return null;
}

// ── Extract article links from HTML ──────────────────────────────────────────
function extractLinksFromHtml(html, seen) {
  const $ = cheerio.load(html);
  const links = [];
  seen = seen || new Set();
  $('a[href*="/article/"]').each((_, el) => {
    const full = normaliseArticleHref($(el).attr('href') || '');
    if (!full) return;
    if (!seen.has(full)) { seen.add(full); links.push(full); }
  });
  return links;
}

// ── Fetch page 1: GET category URL, extract links + AJAX context ─────────────
async function fetchFirstPage(categoryUrl) {
  try {
    const resp = await retryWithBackoff(() => axios.get(categoryUrl, {
      timeout: 20000,
      headers: browserHeaders(),
    }));
    if (resp.status !== 200) return null;
    const html = resp.data;
    const $    = cheerio.load(html);

    // Extract CSRF token from meta or hidden input or inline JSON
    let csrfToken = null;
    const metaCsrf = $('meta[name="csrf-token"]').attr('content');
    if (metaCsrf) {
      csrfToken = metaCsrf;
    } else {
      // Try hidden input[name="_token"]
      const tokenInput = $('input[name="_token"]').first();
      if (tokenInput.length) {
        csrfToken = tokenInput.val() || null;
      } else {
        // Regex scan the raw HTML
        const m = html.match(/_token["\']?\s*[:=]\s*["\']([^"\']+)["\']/);
        if (m) csrfToken = m[1];
      }
    }

    // Extract pagination context inputs
    const catSlug   = $('#catSlug').val()   || $('input[name="catSlug"]').first().val()   || null;
    const posCatIds = $('#posCatID').val()  || $('input[name="posCatID"]').first().val()  || null;

    if (!csrfToken || !catSlug) {
      log(`   [WARN] CSRF token or catSlug missing — pagination disabled`);
    }

    // Capture session cookies so the POST /cat-load-more can pass them back —
    // Laravel validates _token against the laravel_session cookie; without it,
    // the server returns 419 PAGE EXPIRED and pagination silently fails.
    const rawCookies = resp.headers['set-cookie'] || [];
    const sessionCookies = rawCookies.map(c => c.split(';')[0]).join('; ');

    const seen  = new Set();
    const links = extractLinksFromHtml(html, seen);
    log(`   Found ${links.length} links on page 1`);

    return { links, csrfToken, catSlug, posCatIds, seen, sessionCookies };
  } catch (e) {
    log(`   [WARN] Category page fetch failed: ${String(e.message).substring(0, 80)}`);
    return null;
  }
}

// ── Fetch next pages: POST /cat-load-more ────────────────────────────────────
async function fetchNextPage(categoryUrl, catSlug, posCatIds, csrfToken, page, seen, sessionCookies) {
  try {
    const body = new URLSearchParams({
      slug:      catSlug,
      posCatIDs: posCatIds || '',
      page:      String(page),
      _token:    csrfToken,
    }).toString();

    const headers = {
      ...ajaxHeaders(categoryUrl),
      // Pass the session cookie so Laravel can verify the CSRF token
      ...(sessionCookies ? { 'Cookie': sessionCookies } : {}),
    };

    const resp = await retryWithBackoff(() => axios.post(LOAD_MORE_URL, body, {
      timeout: 20000,
      headers,
      responseType: 'json',
    }));
    if (resp.status !== 200) return [];

    const html = (resp.data && resp.data.html) || '';
    if (!html || html.trim() === '') return [];

    const links = extractLinksFromHtml(html, seen);
    log(`   [PAGE ${page}] Found ${links.length} new links`);
    return links;
  } catch (e) {
    log(`   [WARN] AJAX page ${page} failed: ${String(e.message).substring(0, 80)}`);
    return [];
  }
}

// ── Fetch and parse a single article page ────────────────────────────────────
async function fetchArticle(url) {
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

// ── Scrape article data ───────────────────────────────────────────────────────
async function scrapeArticle(url, html) {
  try {
    html = html || await fetchArticle(url);
    if (!html) return null;

    const $ = cheerio.load(html);

    // Headline
    const headline = $('h1').first().text().trim() || null;

    // Date from div.dateAndTime
    const dateText = $('div.dateAndTime').first().text().trim();
    const isoDate  = parseBengaliDatetime(dateText) || 'Not Available';

    // Content: div#contentDetails → <p> tags with ≥20 chars
    const contentDiv = $('#contentDetails').first();
    const parts = [];
    if (contentDiv.length) {
      contentDiv.find('p').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length >= 20) parts.push(t);
      });
    }
    const content = parts.length ? parts.join('\n\n') : null;

    // Image: og:image meta tag
    const imageUrl = $('meta[property="og:image"]').attr('content') || null;

    // Tags: div.tagArea a text
    const tagSet = new Set();
    $('div.tagArea a').each((_, el) => {
      const t = $(el).text().trim();
      if (t) tagSet.add(t);
    });
    const tags = tagSet.size ? Array.from(tagSet).join(',') : '';

    if (!headline) {
      log(`   [WARN] No headline found for ${url.split('/').pop()}`);
      return null;
    }

    // Download image using article ID in filename
    const articleId = extractArticleId(url);
    const imageName = imageUrl ? await downloadImage(imageUrl, articleId) : null;

    log(`   Scraped: headline=${headline.length} chars, content=${parts.length} para(s)`);
    return { headline, isoDate, content, imageName, tags };
  } catch (e) {
    log(`   [ERROR] scrapeArticle(${url.split('/').pop()}): ${String(e.message).substring(0, 100)}`);
    return null;
  }
}

// ── Process a single article with date cutoff check ──────────────────────────
// Returns: 'new' | 'old' | 'exists' | 'error'
async function processArticle(url, cutoffStr, sectionLabel, categoryId) {
  try {
    // Skip if already in DB
    if (await urlExists(url)) {
      log(`   [SKIP] Already in DB: ${url.split('/').pop()}`);
      return 'exists';
    }

    // Fetch and scrape article
    const html = await fetchArticle(url);
    if (!html) {
      log(`   [SKIP] Could not fetch: ${url.split('/').pop()}`);
      return 'error';
    }

    const $ = cheerio.load(html);

    // Extract date for cutoff check
    const dateText = $('div.dateAndTime').first().text().trim();
    const isoDate  = parseBengaliDatetime(dateText);

    if (isoDate && cutoffStr) {
      if (isoDate <= cutoffStr) {
        log(`   [SKIP] Old article: ${isoDate} (cutoff: ${cutoffStr})`);
        return 'old';
      }
    }

    // Scrape remaining fields from the already-loaded $
    const headline = $('h1').first().text().trim() || null;
    if (!headline) {
      log(`   [SKIP] No headline: ${url.split('/').pop()}`);
      return 'error';
    }

    const parts = [];
    $('#contentDetails').first().find('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t.length >= 20) parts.push(t);
    });
    const content = parts.length ? parts.join('\n\n') : '';

    const imageUrl = $('meta[property="og:image"]').attr('content') || null;
    const tagSet   = new Set();
    $('div.tagArea a').each((_, el) => {
      const t = $(el).text().trim();
      if (t) tagSet.add(t);
    });
    const tags = tagSet.size ? Array.from(tagSet).join(',') : '';

    const articleId = extractArticleId(url);
    const imageName = imageUrl ? await downloadImage(imageUrl, articleId) : null;

    // Check headline dedup
    const existingId = HEADLINE_TO_ID[headline];
    if (existingId) {
      log(`   [SKIP] Duplicate headline (id ${existingId}): ${headline.substring(0, 40)}`);
      return 'exists';
    }

    try {
      const newId = await insertArticle({
        headline,
        isoDate: isoDate || 'Not Available',
        content,
        imageName,
        url,
        tags,
        category: categoryId,
        section:  sectionLabel,
      });
      if (newId) {
        HEADLINE_TO_ID[headline] = newId;
        log(`[OK] Inserted new article (ID: ${newId})`);
        return 'new';
      }
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        log(`   Article already exists in DB (duplicate URL)`);
        return 'exists';
      }
      throw e;
    }

    return 'error';
  } catch (e) {
    log(`   [ERROR] processArticle(${url.split('/').pop()}): ${String(e.message).substring(0, 100)}`);
    return 'error';
  }
}

// ── Category ID resolver ──────────────────────────────────────────────────────
// samakal uses numeric category IDs from the DB; fall back to 1 if unknown
const SECTION_TO_CAT_ID = {
  'samakal-national':      1,
  'samakal-politics':      2,
  'samakal-economy':       3,
  'samakal-international': 4,
  'samakal-sports':        5,
  'samakal-entertainment': 6,
  'samakal-tech':          7,
  'samakal-lifestyle':     8,
  'samakal-opinion':       9,
  'samakal-crime':        10,
  'samakal-country':      11,
  'samakal-education':    12,
};

function getCategoryId(sectionLabel) {
  return SECTION_TO_CAT_ID[sectionLabel] || 1;
}

// ── Scrape one category (all pages) ─────────────────────────────────────────
async function scrapeCategory(categoryUrl, sectionLabel, cutoffStr) {
  const catId = getCategoryId(sectionLabel);
  let consecutiveOld   = 0;
  let totalNew         = 0;
  let articleCount     = 0;

  log(`[STATUS:finding:Searching ${sectionLabel}]`);

  // Page 1
  const pageCtx = await fetchFirstPage(categoryUrl);
  if (!pageCtx) {
    log(`   [ERROR] Could not fetch category page: ${categoryUrl}`);
    return totalNew;
  }

  const { csrfToken, catSlug, posCatIds, seen, sessionCookies } = pageCtx;

  // Process page 1 articles
  for (const url of pageCtx.links) {
    articleCount++;
    log(`\n[STATUS:extracting:${articleCount}]`);
    log(`   ${url.split('/').pop()} — ${url}`);

    const result = await processArticle(url, cutoffStr, sectionLabel, catId);
    if (result === 'new') {
      totalNew++;
      consecutiveOld = 0;
    } else {
      consecutiveOld++;
    }
    await sleep(300);
  }

  // Pages 2-MAX_PAGES
  if (csrfToken && catSlug) {
    for (let page = 2; page <= MAX_PAGES; page++) {
      if (consecutiveOld >= MAX_CONSECUTIVE_OLD) {
        log(`   [STOP] ${consecutiveOld} consecutive old/in-DB articles — stopping pagination`);
        break;
      }

      log(`\n   Fetching page ${page}...`);
      const links = await fetchNextPage(categoryUrl, catSlug, posCatIds, csrfToken, page, seen, sessionCookies);

      if (!links.length) {
        log(`   [STOP] No new links on page ${page}`);
        break;
      }

      for (const url of links) {
        if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;

        articleCount++;
        log(`\n[STATUS:extracting:${articleCount}]`);
        log(`   ${url.split('/').pop()} — ${url}`);

        const result = await processArticle(url, cutoffStr, sectionLabel, catId);
        if (result === 'new') {
          totalNew++;
          consecutiveOld = 0;
        } else {
          consecutiveOld++;
        }
        await sleep(300);
      }

      await sleep(500);
    }
  }

  log(`   Category ${sectionLabel}: processed ${articleCount} links, ${totalNew} new`);
  return totalNew;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('SAMAKAL.COM NEWS SCRAPER - MySQL Version');
  log('='.repeat(70));
  log(`Start time: ${nowStr()}`);
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

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
      log('No active Samakal categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Samakal categories`);

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
      let cutoffStr;
      if (!lastTimestamp) {
        const today = new Date();
        cutoffStr = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}T00:00:00`;
        log(`Last Run: Never (First time) — collecting today's articles only`);
      } else {
        cutoffStr = lastTimestamp.replace(' ', 'T');
        log(`Last Run: ${lastTimestamp}`);
      }

      // Capture timestamp BEFORE extraction to avoid missing articles published during cycle
      const cycleSectionStart = nowStr();

      await scrapeCategory(categoryUrl, sectionLabel, cutoffStr);

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
