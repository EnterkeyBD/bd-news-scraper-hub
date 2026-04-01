#!/usr/bin/env node
'use strict';

/**
 * Desh TV Scraper – Node.js
 * Ported from desh-scraper/scrapdesh_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active desh-* categories from MySQL
 *  - Paginates via AJAX more_cat_ajax.php, stops at cutoff timestamp
 *  - Parses Bengali 24-hr dates, converts to ISO 8601
 *  - Downloads article images to desh-scraper/news_images/
 *  - Strips last word from content (watermark removal)
 *  - Inserts country-news into locations table with div/district/upazilla
 *  - Retries failed articles on each cycle
 *  - Reads cycle time from scraper_cycle_config.json (default 60 s)
 *  - Emits [STATUS:...] tokens and ✓ article tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'desh.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'desh');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 60; // seconds

// ── DB Config ──────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host:             '103.213.38.238',
  port:             3306,
  user:             'siamvidb_scraptestg',
  password:         'HuHmf!w=E]%I=3L&',
  database:         'siamvidb_scraptestg',
  charset:          'utf8mb4',
  connectTimeout:   30000,
  waitForConnections: true,
  connectionLimit:  3,
};

// ── Site config ────────────────────────────────────────────────────────────
const BASE_URL = 'https://www.desh.tv';
const AJAX_URL = 'https://www.desh.tv/templates/desh-web/category_page/more_cat_ajax.php';

const DIVISIONS = new Set([
  'dhaka','chittagong','sylhet','rajshahi','khulna','barisal','rangpur','mymensingh',
]);

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
const MONTH_IDX = {
  January:1,February:2,March:3,April:4,May:5,June:6,
  July:7,August:8,September:9,October:10,November:11,December:12,
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// ── Tiny helpers ───────────────────────────────────────────────────────────
function log(msg)    { process.stdout.write(String(msg) + '\n'); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
function randomUA()  { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function pad2(n)     { return String(n).padStart(2, '0'); }

function bn2en(s) {
  return [...String(s)].map(c => BN_DIGITS[c] !== undefined ? BN_DIGITS[c] : c).join('');
}

/**
 * Convert Desh Bengali date "DD Month YYYY, HH:MM" (24-hr) → "YYYY-MM-DDTHH:MM:SS"
 */
function toISO(bengaliDate) {
  try {
    let s = bn2en(bengaliDate.trim());
    for (const [bn, en] of Object.entries(BN_MONTHS)) {
      if (s.includes(bn)) { s = s.replace(bn, en); break; }
    }
    // "24 March 2026, 14:30"
    const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const mo = MONTH_IDX[m[2]];
    if (!mo) return null;
    return `${m[3]}-${pad2(mo)}-${pad2(+m[1])}T${pad2(+m[4])}:${pad2(+m[5])}:00`;
  } catch { return null; }
}

/** Compare two timestamp strings "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS".
 *  Returns true if a >= b. */
function tsGte(a, b) {
  if (!a || !b) return true;
  return a.replace(' ','T') >= b.replace(' ','T');
}

/** Current timestamp as "YYYY-MM-DD HH:MM:SS" */
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ── Cycle time ─────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    if (cfg.scrapers && cfg.scrapers.desh != null) return Number(cfg.scrapers.desh);
    if (cfg.global_cycle_time != null) return Number(cfg.global_cycle_time);
  } catch { /* ignore */ }
  return DEFAULT_CYCLE;
}

// ── Last-processed timestamps ──────────────────────────────────────────────
function loadLastProcessed() {
  try {
    if (fs.existsSync(LAST_PROC_FILE))
      return JSON.parse(fs.readFileSync(LAST_PROC_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function saveLastProcessed(data) {
  fs.writeFileSync(LAST_PROC_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Database ───────────────────────────────────────────────────────────────
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function dbQuery(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function getActiveCategories() {
  return dbQuery(
    "SELECT category_url, section_label FROM categories WHERE is_active=1 AND section_label LIKE 'desh-%' ORDER BY section_label"
  );
}

async function urlExists(url) {
  const rows = await dbQuery('SELECT COUNT(*) AS cnt FROM articles WHERE source_url=?', [url]);
  return rows[0].cnt > 0;
}

async function getArticleByUrl(url) {
  const rows = await dbQuery('SELECT * FROM articles WHERE source_url=? LIMIT 1', [url]);
  return rows[0] || null;
}

async function insertArticle({ headline, publishedAt, content, imageName, sourceUrl, sourceSite, tags, category, section }) {
  try {
    const pubDt = publishedAt ? new Date(publishedAt) : null;
    const [result] = await getPool().execute(
      'INSERT INTO articles (headline, actual_headline, published_at, content, image_name, source_url, source_site, tags, category, section, scraping_status, processing_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [headline, headline, pubDt, content, imageName, sourceUrl, sourceSite, tags, category, section, 'Success', 1]
    );
    return result.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return null;
    throw e;
  }
}

async function updateArticleSuccess({ id, headline, publishedAt, content, imageName, sourceSite, tags, category, section }) {
  const pubDt = publishedAt ? new Date(publishedAt) : null;
  await getPool().execute(
    "UPDATE articles SET headline=?, actual_headline=?, published_at=?, content=?, image_name=?, source_site=?, tags=?, category=?, section=?, scraping_status='Success', processing_count=processing_count+1 WHERE id=?",
    [headline, headline, pubDt, content, imageName, sourceSite, tags, category, section, id]
  );
}

async function insertFailedUrl(sourceUrl, sourceSite, section, errorMsg) {
  try {
    await getPool().execute(
      'INSERT INTO articles (headline, actual_headline, published_at, content, image_name, source_url, source_site, tags, category, section, scraping_status, processing_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ['Failed to scrape', null, null, null, null, sourceUrl, sourceSite, `Error: ${errorMsg || 'unknown'}`, 'Not Available', section, 'Failed', 1]
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') log(`DB insertFailedUrl error: ${e.message}`);
  }
}

async function updateArticleFailed(id, errorMsg) {
  await getPool().execute(
    "UPDATE articles SET scraping_status='Failed', processing_count=processing_count+1, tags=? WHERE id=?",
    [`Error: ${errorMsg || 'unknown'}`, id]
  );
}

async function getFailedArticles() {
  return dbQuery(
    "SELECT * FROM articles WHERE scraping_status='Failed' AND processing_count < 10 AND section LIKE 'desh-%'"
  );
}

async function getAutorun() {
  try {
    const rows = await dbQuery("SELECT autorun FROM scraper_autorun WHERE site='desh' LIMIT 1");
    return rows[0] ? rows[0].autorun : 1;
  } catch { return 1; }
}

// For location (country-news) articles
async function getLocationByUrl(url) {
  const rows = await dbQuery('SELECT * FROM locations WHERE source_url=? LIMIT 1', [url]);
  return rows[0] || null;
}

async function insertLocationArticle({ headline, publishedAt, content, imageName, sourceUrl, sourceSite, tags, category, section, division, district, upazilla }) {
  try {
    const pubDt = publishedAt ? new Date(publishedAt) : null;
    const [result] = await getPool().execute(
      'INSERT INTO locations (headline, actual_headline, published_at, content, image_name, source_url, source_site, tags, category, section, division, district, upazilla, scraping_status, processing_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [headline, headline, pubDt, content, imageName, sourceUrl, sourceSite, tags, category, section, division, district, upazilla || null, 'Success', 1]
    );
    return result.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return null;
    throw e;
  }
}

// ── Location extraction ────────────────────────────────────────────────────
function extractLocation(sectionLabel) {
  // Format: desh-division-district[-upazilla]
  const parts = sectionLabel.split('-');
  if (parts.length < 3) return null;
  if (!DIVISIONS.has(parts[1])) return null;
  return {
    division: parts[1],
    district: parts[2],
    upazilla: parts.length > 3 ? parts.slice(3).join('-') : null,
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function buildHeaders(referer) {
  return {
    'User-Agent':      randomUA(),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'bn-BD,bn;q=0.8,en-US;q=0.5,en;q=0.3',
    ...(referer ? { 'Referer': referer } : {}),
  };
}

async function fetchPage(url, extraHeaders = {}) {
  const resp = await axios.get(url, {
    headers: { ...buildHeaders(), ...extraHeaders },
    timeout: 15000,
    responseType: 'text',
  });
  return resp.data;
}

// ── Article date cache ─────────────────────────────────────────────────────
const articleDateCache = new Map();

/** Fetch article page just for the date; returns ISO string or null. Cached. */
async function getArticleDateISO(url) {
  if (articleDateCache.has(url)) return articleDateCache.get(url);
  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);
    const timeEl = $('div.entry_update time');
    const raw  = timeEl.length ? timeEl.text().trim() : null;
    const iso  = raw ? toISO(raw) : null;
    articleDateCache.set(url, iso);
    return iso;
  } catch {
    return null;
  }
}

// ── Link processing ────────────────────────────────────────────────────────
function processLinks(rawLinks) {
  const seen = new Set();
  return rawLinks
    .map(href => href.startsWith('/') ? `${BASE_URL}${href}` : href)
    .filter(href => href.includes('desh.tv'))
    .filter(href => { if (seen.has(href)) return false; seen.add(href); return true; });
}

async function filterByTimestamp(links, cutoffISO) {
  const result = [];
  for (const url of links) {
    try {
      const iso = await getArticleDateISO(url);
      if (!iso) {
        log(`[!] Date unavailable for ${url} – including anyway`);
        result.push(url);
        continue;
      }
      const articleId = url.split('/').slice(-2)[0];
      if (iso >= cutoffISO) {
        log(`✅ Found article ID ${articleId} at ${iso}`);
        result.push(url);
      } else {
        log(`🚫 Skipping article ID ${articleId} (published ${iso}, before cutoff ${cutoffISO})`);
      }
    } catch (e) {
      log(`[!] Error checking date for ${url} – including anyway: ${e.message}`);
      result.push(url);
    }
  }
  return result;
}

async function sortByDate(urls) {
  const pairs = [];
  for (const url of urls) {
    const iso = await getArticleDateISO(url);
    pairs.push([url, iso || '0000-00-00T00:00:00']);
  }
  pairs.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  log(`Sorted ${pairs.length} URLs by publication date (oldest to newest)`);
  return pairs.map(p => p[0]);
}

// ── AJAX pagination ─────────────────────────────────────────────────────────
async function loadMoreArticles(catId, page, sectionLabel, categoryUrl) {
  try {
    const resp = await axios.get(AJAX_URL, {
      params: { page, cat: catId },
      headers: {
        ...buildHeaders(`${BASE_URL}/${sectionLabel}`),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });
    const $ = cheerio.load(resp.data);
    const rawLinks = [];
    $('div.sub-news a').each((_, el) => {
      const href = $(el).attr('href');
      if (href) rawLinks.push(href);
    });
    if (!rawLinks.length) {
      log(`No sub-news items found in AJAX response`);
      return [];
    }
    const clean = processLinks(rawLinks);
    log(`Found ${clean.length} links from AJAX request (page ${page})`);
    return clean;
  } catch (e) {
    log(`Error loading more articles via AJAX: ${e.message}`);
    return [];
  }
}

// ── Extract news links from a category page ────────────────────────────────
async function extractNewsLinks(categoryUrl, sectionLabel, lastRunTimestamp) {
  let cutoffISO;
  if (!lastRunTimestamp) {
    const d = new Date();
    cutoffISO = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T00:00:00`;
    log(`No last run timestamp, scraping today's articles only (after ${cutoffISO})`);
  } else {
    cutoffISO = lastRunTimestamp.replace(' ', 'T');
    log(`Extracting news links from Desh: ${categoryUrl}`);
    log(`Looking for articles published at or after: ${lastRunTimestamp}`);
  }

  try {
    const html = await fetchPage(categoryUrl);
    const $    = cheerio.load(html);
    const rawLinks = [];

    // Main lead story
    $('div.cat_lead a.link').each((_, el) => {
      const h = $(el).attr('href'); if (h) rawLinks.push(h);
    });
    // Secondary lead stories
    $('div.cat_sub_lead a.link').each((_, el) => {
      const h = $(el).attr('href'); if (h) rawLinks.push(h);
    });
    // Additional news (catsubMoremedianews)
    $('div.catsubMoremedianews div.sub-news a').each((_, el) => {
      const h = $(el).attr('href'); if (h) rawLinks.push(h);
    });
    // Common lead content
    $('div.common-lead-content a').each((_, el) => {
      const h = $(el).attr('href'); if (h) rawLinks.push(h);
    });

    // Look for AJAX "আরও" button
    const moreBtn = $('a#find_more');
    const catId   = moreBtn.attr('data-cat-id');

    if (catId) {
      log(`Found 'আরও' button with category ID: ${catId}`);
      const firstPage = processLinks(rawLinks);
      let articles   = await filterByTimestamp(firstPage, cutoffISO);
      log(`Found ${articles.length} articles at or after cutoff on the first page`);

      // Paginate until we hit an article older than cutoff
      let page = 1;
      let stop = false;
      while (!stop) {
        log(`Loading more articles via AJAX (page ${page})...`);
        const ajaxLinks = await loadMoreArticles(catId, page, sectionLabel, categoryUrl);
        if (!ajaxLinks.length) {
          log(`No more articles found after page ${page}`);
          break;
        }
        for (const url of ajaxLinks) {
          const iso = await getArticleDateISO(url);
          const articleId = url.split('/').slice(-2)[0];
          if (!iso) {
            log(`[!] Article ID ${articleId} datetime unavailable, including anyway`);
            articles.push(url);
          } else if (iso >= cutoffISO) {
            log(`✅ Found article ID ${articleId} at ${iso}`);
            articles.push(url);
          } else {
            log(`Found article older than cutoff: ${iso}. Stopping pagination.`);
            stop = true;
            break;
          }
        }
        if (!stop) {
          page++;
          await sleep(2000);
        }
      }
      articles = await sortByDate(articles);
      return articles;
    } else {
      log(`No 'আরও' button found or missing category ID`);
    }

    const clean    = processLinks(rawLinks);
    const filtered = await filterByTimestamp(clean, cutoffISO);
    return await sortByDate(filtered);
  } catch (e) {
    log(`Error extracting news links from ${categoryUrl}: ${e.message}`);
    return [];
  }
}

// ── Image download ─────────────────────────────────────────────────────────
async function downloadImage(imgUrl) {
  try {
    if (!imgUrl.startsWith('http')) imgUrl = `${BASE_URL}${imgUrl}`;
    const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const imageName = path.basename(imgUrl.split('?')[0]);
    const imgPath   = path.join(IMG_FOLDER, imageName);
    fs.writeFileSync(imgPath, Buffer.from(resp.data));
    log(`Image downloaded: ${imgPath}`);
    return imageName;
  } catch (e) {
    log(`Failed to download image: ${e.message}`);
    return 'Not Available';
  }
}

// ── Process a single article URL ───────────────────────────────────────────
async function processUrl(url, sectionLabel, existingRow) {
  // Skip already-succeeded articles
  if (!existingRow) {
    existingRow = await getArticleByUrl(url);
  }
  if (existingRow) {
    if (existingRow.scraping_status === 'Success') {
      log(`Skipping already processed URL (success): ${url}`);
      return true;
    }
    if (existingRow.scraping_status === 'Failed' && (existingRow.processing_count || 0) >= 10) {
      log(`Skipping URL with max retries reached: ${url}`);
      return false;
    }
  }

  const articleId = url.split('/').slice(-2)[0];
  const sourceSite = 'desh.tv';
  log(`Processing article ID ${articleId} from Desh (section: ${sectionLabel})`);
  await sleep(500);

  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);

    // Date
    const timeEl = $('div.entry_update time');
    const rawDate = timeEl.length ? timeEl.text().trim() : null;
    const isoDate = rawDate ? toISO(rawDate) : null;

    // Headline
    const headline = $('h1.details-title').text().trim() || null;

    // Content: all paragraphs, then remove last word (watermark)
    const contentParts = [];
    $('div.dtl_content_section p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) contentParts.push(t);
    });
    let newsContent = contentParts.join(' ');
    if (newsContent) {
      const words = newsContent.split(/\s+/);
      newsContent = words.length > 1 ? words.slice(0, -1).join(' ') : '';
    }

    // Validations
    if (!headline || headline.length < 3) {
      log(`Invalid headline, skipping article: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid headline');
      else await insertFailedUrl(url, sourceSite, sectionLabel, 'Invalid headline');
      return false;
    }
    if (!isoDate || isoDate.length < 10) {
      log(`Invalid date, skipping article: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid date');
      else await insertFailedUrl(url, sourceSite, sectionLabel, 'Invalid date');
      return false;
    }
    if (!newsContent || newsContent.trim().length < 20) {
      log(`Invalid or insufficient news content, skipping article: ${url}`);
      if (existingRow) await updateArticleFailed(existingRow.id, 'Invalid or insufficient content');
      else await insertFailedUrl(url, sourceSite, sectionLabel, 'Invalid or insufficient content');
      return false;
    }

    // Image
    const imgEl   = $('img.img-fluid.detailImg');
    const imgSrc  = imgEl.attr('src');
    const imageName = imgSrc ? await downloadImage(imgSrc) : 'Not Available';

    // Tags
    const tagList = [];
    $('div#tags_list a').each((_, el) => { const t = $(el).text().trim(); if (t) tagList.push(t); });
    const tags = tagList.length ? tagList.join(', ') : 'Not Available';

    // Category
    const catEl   = $('div#site_map_dtl li.child');
    const category = catEl.length ? catEl.first().text().trim() : 'Not Available';

    // Strip trailing punctuation from headline
    const cleanHeadline = headline.replace(/[!"#%&'()*+,\-./:;<=>?@[\\\]^_`{|}~।]+$/u, '');

    log(`✓ Scraped: headline=${cleanHeadline.length} chars, content=${newsContent.length} chars`);

    const articleData = {
      headline:    cleanHeadline,
      publishedAt: isoDate,
      content:     newsContent,
      imageName,
      sourceUrl:   url,
      sourceSite,
      tags,
      category,
      section:     sectionLabel,
    };

    if (existingRow) {
      await updateArticleSuccess({ id: existingRow.id, ...articleData });
      log(`✓ Updated existing article (id ${existingRow.id})`);
    } else {
      const newId = await insertArticle(articleData);
      if (newId) {
        log(`✓ Inserted new article (id ${newId})`);
      } else {
        log(`Article already exists in database (duplicate URL)`);
      }
    }

    // Location table for country-news sections
    const loc = extractLocation(sectionLabel);
    if (loc) {
      try {
        const existing = await getLocationByUrl(url);
        if (!existing) {
          const locId = await insertLocationArticle({ ...articleData, ...loc });
          if (locId) {
            log(`✓ Also stored in locations table (id ${locId}) with location: ${loc.division}/${loc.district}/${loc.upazilla || ''}`);
          }
        } else {
          log(`Location article already exists for ${url}`);
        }
      } catch (e) {
        log(`Error inserting into locations table: ${e.message}`);
      }
    }

    return true;
  } catch (e) {
    if (e.response) {
      log(`Failed to fetch article ${articleId} (HTTP ${e.response.status})`);
      const msg = `HTTP ${e.response.status}`;
      if (existingRow) await updateArticleFailed(existingRow.id, msg);
      else await insertFailedUrl(url, sourceSite, sectionLabel, msg);
    } else {
      log(`Error processing article ${articleId}: ${e.message}`);
      if (existingRow) await updateArticleFailed(existingRow.id, e.message);
      else await insertFailedUrl(url, sourceSite, sectionLabel, e.message);
    }
    return false;
  }
}

// ── Main scraping loop ─────────────────────────────────────────────────────
async function main() {
  // Ensure image folder exists
  fs.mkdirSync(IMG_FOLDER, { recursive: true });

  let lastProcessed = loadLastProcessed();
  log(`Last processed timestamps by section: ${JSON.stringify(lastProcessed)}`);
  log('Note: Timestamp-based approach automatically handles missed articles');

  let cycleTime = getCycleTime();
  log(`Cycle Time: ${cycleTime}s`);

  while (true) {
    cycleTime = getCycleTime();
    articleDateCache.clear();

    // Load active categories each cycle (hot-reload)
    let categories;
    try {
      categories = await getActiveCategories();
    } catch (e) {
      log(`Error loading categories: ${e.message}`);
      categories = [];
    }

    if (!categories.length) {
      log('No active Desh categories found in database. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }

    log(`\nMonitoring ${categories.length} active Desh categories`);

    // Retry failed articles
    log('[STATUS:finding:Checking for failed articles]');
    let failedRows = [];
    try {
      failedRows = await getFailedArticles();
    } catch (e) {
      log(`Error loading failed articles: ${e.message}`);
    }
    if (failedRows.length) log(`Retrying ${failedRows.length} failed URLs from DB`);
    for (const row of failedRows) {
      const url = row.source_url;
      const sec = row.section || 'unknown';
      log(`Retrying failed URL (attempt ${(row.processing_count || 0) + 1}/10): ${url}`);
      const ok = await processUrl(url, sec, row);
      log(ok ? `✅ Retry succeeded => ${url}` : `❌ Retry still failing => ${url}`);
      await sleep(2000);
    }

    const cycleStartMs = Date.now();
    const cycleStartStr = nowStr();
    log(`\n${'='.repeat(50)}`);
    log(`Starting new cycle at ${cycleStartStr}`);
    log(`${'='.repeat(50)}\n`);

    for (const { category_url, section_label } of categories) {
      log(`\n${'='.repeat(50)}`);
      log(`Checking category: ${section_label}`);
      log(`${'='.repeat(50)}\n`);

      const lastTimestamp = lastProcessed[section_label] || null;

      log(`[STATUS:finding:Searching ${section_label}]`);
      const cycSectionStart = nowStr();

      const links = await extractNewsLinks(category_url, section_label, lastTimestamp);

      // Deduplicate against DB
      const newLinks = [];
      for (const url of links) {
        if (!(await urlExists(url))) newLinks.push(url);
      }
      log(`Found ${links.length} total links since last run (${newLinks.length} new, ${links.length - newLinks.length} already in DB)`);

      for (let i = 0; i < newLinks.length; i++) {
        const url = newLinks[i];
        log(`[STATUS:extracting:${i + 1}/${newLinks.length}]`);
        log(`\n[INFO] Processing new URL: ${url}`);
        const ok = await processUrl(url, section_label, null);
        log(ok ? `Successfully processed => ${url}` : `Failed => stored as Failed in DB for retry`);
        await sleep(2000);
      }

      // Save timestamp (using pre-extraction start time)
      lastProcessed[section_label] = cycSectionStart;
      saveLastProcessed(lastProcessed);

      log(`Completed processing for ${section_label}. Pausing briefly...`);
      await sleep(2000);
    }

    // Check autorun flag
    try {
      const autorun = await getAutorun();
      if (autorun === 0) {
        log('[AUTORUN OFF] Autorun is disabled. Scraper completed one cycle and will now stop.');
        break;
      }
    } catch (e) {
      log(`[WARNING] Could not check autorun setting: ${e.message}`);
    }

    // Wait for next cycle
    const cycleDurationSecs = (Date.now() - cycleStartMs) / 1000;
    cycleTime = getCycleTime();
    const waitSecs = Math.max(0, cycleTime - cycleDurationSecs);
    if (waitSecs > 0) {
      log(`\nCompleted cycle in ${cycleDurationSecs.toFixed(1)}s. Waiting ${waitSecs.toFixed(1)}s before next cycle...`);
      for (let i = Math.ceil(waitSecs); i > 0; i--) {
        log(`[STATUS:waiting:${i}]`);
        await sleep(1000);
      }
      log('\nStarting new cycle!\n');
    } else {
      log('\nCycle took longer than target interval. Starting next cycle immediately...\n');
    }
  }

  try { await pool.end(); } catch { /* ignore */ }
}

// ── Entry point ────────────────────────────────────────────────────────────
main().catch(e => {
  process.stderr.write(`Fatal error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
