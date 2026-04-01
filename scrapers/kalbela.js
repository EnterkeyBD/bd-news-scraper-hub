#!/usr/bin/env node
'use strict';

/**
 * Kalbela Scraper – Node.js
 * Ported from kalbela-scraper/scrapkalbela_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active kalbela categories from MySQL
 *  - Extracts article links from category page HTML:
 *      div.topLead / div.cat_lead, div.cat-body-news,
 *      div.cat_full / div.catsubMoremedianews / div.body_news_block → div.sub-news,
 *      fallback: all hrefs whose last segment is numeric
 *  - Paginates via AJAX more_cat_ajax.php?page=N&cat=CATID
 *    (cat_id extracted from a#find_more[data-cat-id])
 *    Stops loading more pages when any article older than cutoff is found
 *  - Bengali 12-hr AM/PM date parsing (পিএম/এএম) → ISO 8601
 *    Date selector: div[style*="display: inline-block"],
 *    fallback: any div containing প্রকাশ : / আপডেট : and a Bengali month
 *  - Content: div.dtl_content_section → FIRST paragraph only (Kalbela-specific)
 *  - Image: img.img-fluid.detailImg (fallback: any img with detailImg class)
 *  - Tags: div#tags_list a
 *  - Location insert for country-news sections (division/district/upazilla)
 *  - Retries failed articles each cycle (max 10 attempts)
 *  - Article URLs must end with a numeric ID (filters listing/category pages)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] and ✓ article tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');
const url_lib = require('url');

// ── Paths ──────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'kalbela.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'kalbela');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600; // seconds

// ── DB Config ──────────────────────────────────────────────────────────────
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

// ── Site config ────────────────────────────────────────────────────────────
const BASE_URL    = 'https://www.kalbela.com';
const BASE_DOMAIN = 'www.kalbela.com';
const AJAX_URL    = `${BASE_URL}/templates/web-view/category_page/more_cat_ajax.php`;

const SECTION_TO_CATEGORY_ID = {
  'national':      5,
  'politics':      10,
  'economics':     9,
  'international': 6,
  'sports':        8,
  'entertainment': 14,
  'country-news':  11,
};

// ── Bengali helpers ────────────────────────────────────────────────────────
const BN_DIGITS = {
  '০':'0','১':'1','২':'2','৩':'3','৪':'4',
  '৫':'5','৬':'6','৭':'7','৮':'8','৯':'9',
};
const BN_MONTHS = {
  'জানুয়ারি':'January',  'ফেব্রুয়ারি':'February', 'মার্চ':'March',
  'এপ্রিল':'April',       'মে':'May',               'জুন':'June',
  'জুলাই':'July',          'আগস্ট':'August',         'সেপ্টেম্বর':'September',
  'অক্টোবর':'October',    'নভেম্বর':'November',     'ডিসেম্বর':'December',
};
const BN_MONTH_PATTERN = Object.keys(BN_MONTHS).join('|');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// ── Tiny helpers ───────────────────────────────────────────────────────────
function log(msg)   { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function pad2(n)    { return String(n).padStart(2, '0'); }

function bn2en(s) {
  return [...String(s)].map(c => BN_DIGITS[c] !== undefined ? BN_DIGITS[c] : c).join('');
}

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function axiosHeaders() {
  return {
    'User-Agent':      randomUA(),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'bn-BD,bn;q=0.8,en-US;q=0.5,en;q=0.3',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
  };
}

// ── Date conversion ────────────────────────────────────────────────────────
/**
 * Convert Kalbela Bengali date to ISO 8601.
 * Format: "DD Month YYYY, HH:MM পিএম" or "DD Month YYYY, HH:MM"
 * Strips প্রকাশ : / আপডেট : prefixes.
 */
function convertToISO(raw) {
  try {
    let s = raw.trim();
    s = s.replace(/প্রকাশ\s*:/g, '').replace(/আপডেট\s*:/g, '').trim();
    s = bn2en(s);

    // Replace Bengali month names
    for (const [bn, en] of Object.entries(BN_MONTHS)) {
      if (s.includes(bn)) { s = s.replace(bn, en); break; }
    }

    // Detect and strip Bengali AM/PM
    let isPM = false;
    if (s.includes('পিএম')) { isPM = true;  s = s.replace(/\s*পিএম/g, '').trim(); }
    else if (s.includes('এএম')) {             s = s.replace(/\s*এএম/g, '').trim(); }

    // Parse "DD Month YYYY, HH:MM"
    const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;

    const MONTHS = {
      January:1,February:2,March:3,April:4,May:5,June:6,
      July:7,August:8,September:9,October:10,November:11,December:12,
    };
    let [, day, mon, year, hr, min] = m;
    day  = parseInt(day, 10);
    mon  = MONTHS[mon];
    year = parseInt(year, 10);
    hr   = parseInt(hr, 10);
    min  = parseInt(min, 10);
    if (!mon) return null;

    if (isPM && hr !== 12) hr += 12;
    if (!isPM && hr === 12) hr = 0;

    return `${year}-${pad2(mon)}-${pad2(day)}T${pad2(hr)}:${pad2(min)}:00`;
  } catch (_) {
    return null;
  }
}

/**
 * Extract date text from a cheerio-loaded article page.
 * Looks for div[style*="display: inline-block"] first, then
 * any div containing প্রকাশ : / আপডেট : and a Bengali month.
 */
function extractDateFromPage($) {
  // Primary: div with inline-block style
  let raw = null;
  $('div[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (style.includes('display: inline-block') || style.includes('display:inline-block')) {
      raw = $(el).text().trim();
      return false; // break
    }
  });

  // Fallback: any div containing date prefix and Bengali month
  if (!raw) {
    const monthRx = /জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর/;
    $('div').each((_, el) => {
      const text = $(el).text();
      if ((text.includes('প্রকাশ :') || text.includes('আপডেট :')) && monthRx.test(text)) {
        raw = text.trim();
        return false; // break
      }
    });
  }

  if (!raw) return null;

  // Try to extract just the date portion via regex
  const m = raw.match(/(প্রকাশ|আপডেট)\s*:\s*([\u09E6-\u09EF\d]+\s+[\u0980-\u09FF]+\s+[\u09E6-\u09EF\d]+,\s*[\u09E6-\u09EF\d]+:[\u09E6-\u09EF\d]+(\s*(এএম|পিএম))?)/);
  if (m) raw = m[0];

  return convertToISO(raw);
}

// ── Cycle time ─────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['kalbela'];
    if (typeof v === 'number' && v > 0) return v;
  } catch (_) {}
  return DEFAULT_CYCLE;
}

// ── Last-processed dates ───────────────────────────────────────────────────
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

// ── DB pool ────────────────────────────────────────────────────────────────
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// ── DB helpers ─────────────────────────────────────────────────────────────
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
    [headline, headline, pubDt, content, imageName || null,
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
    [headline, headline, pubDt, content, imageName || null,
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
    `UPDATE articles
        SET scraping_status='Failed',
            processing_count=processing_count+1,
            tags=?
      WHERE id=?`,
    [`Error: ${errMsg}`, id]);
}

async function getFailedArticles(maxRetries, site) {
  const [rows] = await getPool().execute(
    `SELECT * FROM articles
      WHERE scraping_status='Failed'
        AND processing_count < ?
        AND source_site = ?`,
    [maxRetries, site]);
  return rows;
}

async function insertLocationArticle({ headline, isoDate, content, imageName, url, tags, category, section, division, district, upazilla }) {
  let pubDt = null;
  if (isoDate) {
    try { pubDt = new Date(isoDate); if (isNaN(pubDt)) pubDt = null; } catch (_) {}
  }
  const [result] = await getPool().execute(
    `INSERT INTO locations
       (headline, actual_headline, published_at, content, image_name,
        source_url, source_site, tags, category, section,
        division, district, upazilla,
        scraping_status, processing_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Success',1)`,
    [headline, headline, pubDt, content, imageName || null,
     url, BASE_DOMAIN, tags || '', String(category), section,
     division, district, upazilla || null]);
  return result.insertId;
}

async function getLocationArticleByUrl(url) {
  const [rows] = await getPool().execute(
    'SELECT id FROM locations WHERE source_url = ?', [url]);
  return rows[0] || null;
}

async function getActiveCategories() {
  const [rows] = await getPool().execute(
    `SELECT category_url, section_label FROM categories
      WHERE site='kalbela' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  const [rows] = await getPool().execute(
    `SELECT autorun FROM scraper_autorun WHERE site='kalbela'`);
  return rows[0] ? rows[0].autorun : 1;
}

// ── Headline dedup map ─────────────────────────────────────────────────────
const HEADLINE_TO_ID = {};

async function loadHeadlineMap() {
  const [rows] = await getPool().execute(
    `SELECT id, actual_headline FROM articles
      WHERE actual_headline IS NOT NULL AND actual_headline != ''`);
  for (const r of rows) HEADLINE_TO_ID[r.actual_headline] = r.id;
}

// ── Image download ─────────────────────────────────────────────────────────
function ensureImgFolder() {
  if (!fs.existsSync(IMG_FOLDER)) fs.mkdirSync(IMG_FOLDER, { recursive: true });
}

async function downloadImage(imageUrl) {
  try {
    if (!imageUrl) return null;
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/')) imageUrl = BASE_URL + imageUrl;

    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: axiosHeaders(),
    });
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `kalbela_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`✓ Downloaded image: ${fname}`);
    return fname;
  } catch (_) {
    return null;
  }
}

// ── Article URL validation ─────────────────────────────────────────────────
function isArticleUrl(href) {
  try {
    const pathname = new url_lib.URL(href).pathname.replace(/\/$/, '');
    const last = pathname.split('/').pop();
    return /^\d+$/.test(last);
  } catch (_) {
    return false;
  }
}

// ── Date cache (per-cycle) ─────────────────────────────────────────────────
const articleDateCache = new Map();

async function getArticleDateTime(articleUrl) {
  if (articleDateCache.has(articleUrl)) {
    const cached = articleDateCache.get(articleUrl);
    return cached ? new Date(cached) : null;
  }
  try {
    const resp = await axios.get(articleUrl, { timeout: 15000, headers: axiosHeaders() });
    if (resp.status !== 200) { articleDateCache.set(articleUrl, null); return null; }
    const $ = cheerio.load(resp.data);
    const iso = extractDateFromPage($);
    articleDateCache.set(articleUrl, iso);
    return iso ? new Date(iso) : null;
  } catch (_) {
    articleDateCache.set(articleUrl, null);
    return null;
  }
}

// ── Article scraping ───────────────────────────────────────────────────────
async function scrapeArticle(articleUrl) {
  try {
    const resp = await axios.get(articleUrl, { timeout: 15000, headers: axiosHeaders() });
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Headline
    let headline = $('h1.details-title').first().text().trim();
    if (!headline) headline = $('h1').first().text().trim();
    if (!headline) headline = 'No headline';

    // Clean trailing Bengali/ASCII punctuation
    headline = headline.replace(/[।!?.,:;'"]+$/, '').trim();

    // Date
    const isoDate = extractDateFromPage($) || new Date().toISOString().substring(0, 19);
    // Cache it so sort doesn't re-fetch
    if (!articleDateCache.has(articleUrl)) articleDateCache.set(articleUrl, isoDate);

    // Content — KALBELA: first paragraph only
    const contentSection = $('div.dtl_content_section').first()
      || $('div.dtl-class').first()
      || $('div.body-content').first();
    let news_content = '';
    $('div.dtl_content_section, div.dtl-class, div.body-content').first().find('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20 && !news_content) {
        news_content = text;
      }
    });

    // Image: img with both img-fluid and detailImg classes, fallback by detailImg alone
    let imageUrl = '';
    $('img').each((_, el) => {
      const classes = $(el).attr('class') || '';
      if (classes.includes('detailImg') && !imageUrl) {
        imageUrl = $(el).attr('src') || '';
      }
    });
    const imageName = imageUrl ? await downloadImage(imageUrl) : null;

    // Tags
    const tags = [];
    $('div#tags_list a').each((_, el) => tags.push($(el).text().trim()));
    const tagsString = tags.join(', ');

    return { headline, isoDate, content: news_content, imageName, tags: tagsString, url: articleUrl };
  } catch (e) {
    log(`Error scraping article ${articleUrl}: ${e.message}`);
    return null;
  }
}

// ── Location extraction ────────────────────────────────────────────────────
const DIVISIONS = new Set(['dhaka','chittagong','sylhet','rajshahi','khulna','barisal','rangpur','mymensingh']);

function extractLocation(sectionLabel) {
  const lower = sectionLabel.toLowerCase();
  if (!lower.includes('country') && !lower.includes('country-news')) return null;

  const parts = sectionLabel.split('-');
  // Try: kalbela-{division}-{district}[-{upazilla}]
  // or: country news - {division} - {district}
  for (let i = 0; i < parts.length; i++) {
    if (DIVISIONS.has(parts[i].toLowerCase())) {
      const division  = parts[i].toLowerCase();
      const district  = parts[i+1] ? parts[i+1].toLowerCase() : division;
      const upazilla  = parts[i+2] ? parts.slice(i+2).join('-').toLowerCase() : null;
      if (division && district) return { division, district, upazilla };
    }
  }
  return null;
}

// ── Link helpers ───────────────────────────────────────────────────────────
function processAndCleanLinks(links, categoryUrl) {
  let categoryPath;
  try {
    categoryPath = new url_lib.URL(categoryUrl).pathname.replace(/\/$/, '') + '/';
  } catch (_) {
    categoryPath = '/';
  }

  const seen = new Set();
  const result = [];
  for (let href of links) {
    if (href.startsWith('/')) href = BASE_URL + href;
    if (!href.includes('kalbela.com')) continue;

    let linkPath;
    try { linkPath = new url_lib.URL(href).pathname; } catch (_) { continue; }

    if (!linkPath.startsWith(categoryPath)) continue;
    if (!isArticleUrl(href)) continue;
    if (!seen.has(href)) { seen.add(href); result.push(href); }
  }
  return result;
}

async function loadMoreArticles(catId, page) {
  try {
    const resp = await axios.get(AJAX_URL, {
      params: { page, cat: catId },
      timeout: 15000,
      headers: axiosHeaders(),
    });
    if (resp.status !== 200) return [];

    const $ = cheerio.load(resp.data);
    const links = [];
    $('div.sub-news a[href]').each((_, el) => {
      let href = $(el).attr('href');
      if (href.startsWith('/')) href = BASE_URL + href;
      links.push(href);
    });
    log(`✅ Extracted ${links.length} article links from AJAX page ${page}`);
    return links;
  } catch (_) {
    return [];
  }
}

async function extractNewsLinks(categoryUrl, sectionLabel, lastRunTimestamp) {
  try {
    let cutoffDt;
    if (lastRunTimestamp) {
      cutoffDt = new Date(lastRunTimestamp.replace(' ', 'T'));
    } else {
      const now = new Date();
      cutoffDt = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    log(`\n${'='.repeat(50)}`);
    log(`Extracting news links from: ${categoryUrl}`);
    log(`Looking for articles after: ${lastRunTimestamp || 'today'}`);
    log('='.repeat(50) + '\n');

    const resp = await axios.get(categoryUrl, { timeout: 15000, headers: axiosHeaders() });
    if (resp.status !== 200) {
      log(`Failed to fetch ${categoryUrl} (HTTP ${resp.status})`);
      return [];
    }

    // Check for Kalbela database overload
    if (resp.data.includes('Too many connections') || resp.data.includes('SQLSTATE[HY000]')) {
      log('⚠ Kalbela website database error - their server is overloaded. Skipping...');
      return [];
    }

    const $ = cheerio.load(resp.data);

    // Collect initial links from page
    const initialLinks = [];
    const addHref = (href) => { if (href) initialLinks.push(href); };

    // Main lead
    $('div.topLead a[href], div.cat_lead a[href]').each((_, el) => addHref($(el).attr('href')));
    // Cat body news
    $('div.cat-body-news a[href]').each((_, el) => addHref($(el).attr('href')));
    // Sub-news within specific containers
    $('div.cat_full div.sub-news a[href], div.catsubMoremedianews div.sub-news a[href], div.body_news_block div.sub-news a[href]')
      .each((_, el) => addHref($(el).attr('href')));
    // Fallback: all links with numeric last segment
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const full = href.startsWith('/') ? BASE_URL + href : href;
      if (full.includes('kalbela.com') && isArticleUrl(full)) addHref(href);
    });

    log(`Found ${initialLinks.length} links on initial page`);

    // Extract cat_id for AJAX
    const findMoreBtn = $('a#find_more');
    const catId = findMoreBtn.attr('data-cat-id') || null;
    if (catId) log(`Found 'আরও' button with category ID: ${catId}`);

    const cleanInitial = processAndCleanLinks(initialLinks, categoryUrl);
    log(`Cleaned ${cleanInitial.length} links`);

    const allLinks = [];
    let foundOld = false;

    // Check initial page dates
    for (const link of cleanInitial) {
      const dt = await getArticleDateTime(link);
      if (dt) {
        if (dt < cutoffDt) {
          log(`Found article older than cutoff: ${dt.toISOString()}`);
          foundOld = true;
        } else {
          if (!allLinks.includes(link)) {
            allLinks.push(link);
            log(`[+] Found new article at ${dt.toISOString()}`);
          }
        }
      } else {
        if (!allLinks.includes(link)) {
          allLinks.push(link);
          log(`[!] Article datetime unavailable, including anyway`);
        }
      }
      await sleep(100);
    }

    // AJAX pages — stop as soon as any old article found
    if (catId && !foundOld) {
      for (let page = 1; page <= 50 && !foundOld; page++) {
        log(`\nLoading more articles via AJAX (page ${page})...`);
        const ajaxLinks = await loadMoreArticles(catId, page);
        if (!ajaxLinks.length) { log(`No more articles after AJAX page ${page}`); break; }

        const cleanAjax = processAndCleanLinks(ajaxLinks, categoryUrl);
        log(`Loaded ${cleanAjax.length} articles on AJAX page ${page}`);

        for (const link of cleanAjax) {
          const dt = await getArticleDateTime(link);
          if (dt) {
            if (dt < cutoffDt) {
              log(`Found article older than cutoff: ${dt.toISOString()}`);
              foundOld = true;
            } else {
              if (!allLinks.includes(link)) {
                allLinks.push(link);
                log(`[+] Found new article at ${dt.toISOString()}`);
              }
            }
          } else {
            if (!allLinks.includes(link)) {
              allLinks.push(link);
              log(`[!] Article datetime unavailable, including anyway`);
            }
          }
          await sleep(100);
        }
        await sleep(2000);
      }
    }

    // Sort oldest → newest using cached dates
    allLinks.sort((a, b) => {
      const da = articleDateCache.get(a) ? new Date(articleDateCache.get(a)) : new Date(0);
      const db_ = articleDateCache.get(b) ? new Date(articleDateCache.get(b)) : new Date(0);
      return da - db_;
    });

    log(`\nFound total of ${allLinks.length} new articles after last run`);
    return allLinks;
  } catch (e) {
    log(`Error extracting news links from ${categoryUrl}: ${e.message}`);
    return [];
  }
}

// ── Process a single URL ───────────────────────────────────────────────────
async function processUrl(url, sectionLabel, existingRow) {
  try {
    existingRow = existingRow || await getArticleByUrl(url);
    if (existingRow) {
      const status = existingRow.scraping_status;
      const count  = existingRow.processing_count || 0;
      if (status === 'Success') {
        log(`Skipping already processed URL (success): ${url}`);
        return true;
      }
      if (status === 'Failed' && count >= 10) {
        log(`Skipping URL with max retries reached (${count}/10): ${url}`);
        return false;
      }
    }

    const article = await scrapeArticle(url);
    if (!article) {
      log(`Failed to scrape article: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Failed to scrape content');
      else await insertFailedUrl(url, sectionLabel, 'Failed to scrape content');
      return false;
    }

    const { headline, isoDate, content, imageName, tags } = article;

    if (!headline || headline === 'No headline' || headline.trim().length < 3) {
      log(`Invalid headline, skipping: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid headline');
      else await insertFailedUrl(url, sectionLabel, 'Invalid headline');
      return false;
    }
    if (!isoDate || isoDate.trim().length < 10) {
      log(`Invalid date, skipping: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid date');
      else await insertFailedUrl(url, sectionLabel, 'Invalid date');
      return false;
    }
    if (!content || content.trim().length < 20) {
      log(`Insufficient content, skipping: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid or insufficient content');
      else await insertFailedUrl(url, sectionLabel, 'Invalid or insufficient content');
      return false;
    }

    // Category from section label
    const parts       = sectionLabel.split('-');
    const categoryKey = parts[1] || parts[0];
    const category    = SECTION_TO_CATEGORY_ID[categoryKey] || 5;

    const existingId = HEADLINE_TO_ID[headline];
    if (existingId) {
      await updateArticleSuccess(existingId, { headline, isoDate, content, imageName, tags, category, section: sectionLabel });
      log(`✓ Updated existing article (id ${existingId})`);
    } else {
      const newId = await insertArticle({ headline, isoDate, content, imageName, url, tags, category, section: sectionLabel });
      if (newId) {
        HEADLINE_TO_ID[headline] = newId;
        log(`✓ Inserted new article (id ${newId})`);
      } else {
        log('Failed to insert article into DB');
      }
    }

    // Location table for country-news
    const loc = extractLocation(sectionLabel);
    if (loc) {
      const existing = await getLocationArticleByUrl(url);
      if (!existing) {
        const locId = await insertLocationArticle({
          headline, isoDate, content, imageName, url, tags, category,
          section: sectionLabel, ...loc,
        });
        if (locId) log(`✓ Also stored in locations table (id ${locId}) with location: ${loc.division}/${loc.district}/${loc.upazilla}`);
      }
    }

    return true;
  } catch (e) {
    log(`Error processing ${url}: ${e.message}`);
    try { await insertFailedUrl(url, sectionLabel, String(e.message)); } catch (_) {}
    return false;
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('KALBELA.COM NEWS SCRAPER - MYSQL DATABASE');
  log('='.repeat(70));
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

  ensureImgFolder();

  try { await loadHeadlineMap(); } catch (e) { log(`[WARNING] Could not load headline map: ${e.message}`); }

  let lastProcessedDates = loadLastProcessedDates();

  while (true) {
    CYCLE_TIME = getCycleTime();
    // Clear date cache each cycle to avoid stale entries growing unbounded
    articleDateCache.clear();

    let categories = [];
    try {
      categories = await getActiveCategories();
    } catch (e) {
      log(`Error loading categories: ${e.message}. Waiting 60s...`);
      await sleep(60000);
      continue;
    }

    if (!categories.length) {
      log('No active Kalbela categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Kalbela categories`);

    // Retry failed URLs
    log('[STATUS:finding:Checking for failed articles]');
    try {
      const failedRows = await getFailedArticles(10, BASE_DOMAIN);
      if (failedRows.length) {
        log(`\n${'='.repeat(70)}`);
        log(`RETRYING ${failedRows.length} FAILED URLs`);
        log('='.repeat(70));
        for (const row of failedRows) {
          const url     = row.source_url;
          const section = row.section || 'kalbela-national';
          const attempt = (row.processing_count || 0) + 1;
          log(`\nRetrying failed URL (attempt ${attempt}/10): ${url}`);
          const ok = await processUrl(url, section, row);
          log(ok ? `✅ Retry succeeded => ${url}` : `❌ Retry still failing => ${url}`);
        }
      }
    } catch (e) {
      log(`[WARNING] Error retrying failed articles: ${e.message}`);
    }

    const cycleStart = Date.now();
    log(`\n${'='.repeat(70)}`);
    log(`Starting new cycle at ${nowStr()}`);
    log('='.repeat(70) + '\n');

    for (const { category_url: categoryUrl, section_label: sectionLabel } of categories) {
      log(`\n${'='.repeat(50)}`);
      log(`Checking category: ${sectionLabel}`);
      log('='.repeat(50) + '\n');

      const lastTimestamp   = lastProcessedDates[sectionLabel] || null;
      const cycleSecStart   = nowStr();

      log(`[STATUS:finding:Searching ${sectionLabel}]`);
      const links = await extractNewsLinks(categoryUrl, sectionLabel, lastTimestamp);

      const newLinks = [];
      for (const u of links) {
        if (!(await urlExists(u))) newLinks.push(u);
      }
      log(`Found ${links.length} total links (${newLinks.length} new, ${links.length - newLinks.length} already in DB)`);

      for (let idx = 0; idx < newLinks.length; idx++) {
        const u = newLinks[idx];
        log(`[STATUS:extracting:${idx+1}/${newLinks.length}]`);
        log(`\n[INFO] Processing new URL: ${u}`);
        const ok = await processUrl(u, sectionLabel);
        log(ok ? `Successfully processed => ${u}` : `Failed => stored as Failed in DB for retry`);
        await sleep(2000);
      }

      lastProcessedDates[sectionLabel] = cycleSecStart;
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
      log('\nCycle took longer than target interval. Starting next cycle immediately...\n');
    }
  }

  if (pool) await pool.end();
}

main().catch(e => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
