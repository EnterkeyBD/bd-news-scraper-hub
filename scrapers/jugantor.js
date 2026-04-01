#!/usr/bin/env node
'use strict';

/**
 * Jugantor Scraper – Node.js
 * Ported from jugantor-scraper/scrapjugantor_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active jugantor categories from MySQL
 *  - Extracts article links from category page HTML (section-based URLs)
 *  - Paginates via AJAX /ajax/load/categorynews/{cat_id}/20/{page}/20?lastID={lastID}
 *    stops at 3 consecutive articles older than the last-run cutoff
 *  - Bengali 12-hr AM/PM date parsing (পিএম/এএম) → ISO 8601
 *  - Headline: h1.my-3, content: div.desktopDetailBody
 *  - Image: figure img, fallback div.desktopDetailPhotoDiv img
 *  - Tags: div.desktopDetailTag a
 *  - Location insert for country-news sections (division/district/upazilla)
 *  - Retries failed articles each cycle (max 10 attempts)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] and ✓ article tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'jugantor.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'jugantor');
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
const BASE_URL    = 'https://www.jugantor.com';
const BASE_DOMAIN = 'www.jugantor.com';

const SECTION_TO_CATEGORY_ID = {
  'national':     5,
  'politics':     10,
  'economics':    9,
  'international':6,
  'sports':       8,
  'entertainment':14,
  'country-news': 11,
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

/** Current timestamp as "YYYY-MM-DD HH:MM:SS" */
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Convert Bengali date "09 জানুয়ারি 2026, 03:35 পিএম" → "2026-01-09T15:35:00" */
function convertBengaliDate(raw) {
  try {
    let s = raw.trim();
    // Remove publication prefix
    s = s.replace(/প্রকাশ:?/g, '').trim();
    // NFC normalize (JS strings are already Unicode but normalize anyway)
    s = s.normalize('NFC');
    // Convert Bengali digits to ASCII
    s = bn2en(s);
    // Replace Bengali month names
    for (const [bn, en] of Object.entries(BN_MONTHS)) {
      if (s.includes(bn)) { s = s.replace(bn, en); break; }
    }
    // Replace Bengali AM/PM → English
    s = s.replace(/পিএম/g, 'PM').replace(/এএম/g, 'AM');

    // Parse: "09 January 2026, 03:35 PM"
    const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;

    const MONTHS = {
      January:1,February:2,March:3,April:4,May:5,June:6,
      July:7,August:8,September:9,October:10,November:11,December:12,
    };
    let [, day, mon, year, hr, min, ampm] = m;
    day  = parseInt(day, 10);
    mon  = MONTHS[mon];
    year = parseInt(year, 10);
    hr   = parseInt(hr, 10);
    min  = parseInt(min, 10);
    if (!mon) return null;

    if (ampm.toUpperCase() === 'PM' && hr !== 12) hr += 12;
    if (ampm.toUpperCase() === 'AM' && hr === 12) hr = 0;

    return `${year}-${pad2(mon)}-${pad2(day)}T${pad2(hr)}:${pad2(min)}:00`;
  } catch (e) {
    return null;
  }
}

// ── Cycle time ─────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    const v = cfg['jugantor'];
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

// ── DB pool (created once) ─────────────────────────────────────────────────
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
      WHERE site='jugantor' AND is_active=1`);
  return rows;
}

async function getAutorun() {
  const [rows] = await getPool().execute(
    `SELECT autorun FROM scraper_autorun WHERE site='jugantor'`);
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
      headers: { 'User-Agent': randomUA() },
    });
    if (resp.status !== 200) return null;

    ensureImgFolder();
    const suffix = Math.random().toString(36).substring(2, 10);
    const fname  = `jugantor_${suffix}.jpg`;
    fs.writeFileSync(path.join(IMG_FOLDER, fname), resp.data);
    log(`✓ Downloaded image: ${fname}`);
    return fname;
  } catch (_) {
    return null;
  }
}

// ── Article scraping ───────────────────────────────────────────────────────
async function scrapeArticle(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': randomUA() },
    });
    if (resp.status !== 200) return null;

    const $ = cheerio.load(resp.data);

    // Headline
    let headline = $('h1.my-3').first().text().trim();
    if (!headline) headline = $('h1').first().text().trim();
    if (!headline) headline = 'No headline';

    // Date
    let isoDate = null;
    const pubTag = $('p.desktopDetailPTime').first().text().trim();
    if (pubTag) {
      const cleaned = pubTag.replace(/প্রকাশ:?/g, '').trim();
      isoDate = convertBengaliDate(cleaned);
    }
    if (!isoDate) isoDate = new Date().toISOString().replace('T', 'T').substring(0, 19);

    // Content
    const contentDiv = $('div.desktopDetailBody');
    contentDiv.find('script, style').remove();
    const content = contentDiv.text().replace(/\n{3,}/g, '\n\n').trim();

    // Image
    let imageUrl = '';
    const figImg = $('figure img').first();
    if (figImg.length) imageUrl = figImg.attr('src') || '';
    if (!imageUrl) {
      const altImg = $('div.desktopDetailPhotoDiv img').first();
      if (altImg.length) imageUrl = altImg.attr('src') || '';
    }
    const imageName = imageUrl ? await downloadImage(imageUrl) : null;

    // Tags
    const tagLinks = $('div.desktopDetailTag a');
    const tags = [];
    tagLinks.each((_, el) => { tags.push($(el).text().trim()); });
    const tagsString = tags.join(', ');

    return { headline, isoDate, content, imageName, tags: tagsString, url };
  } catch (e) {
    log(`Error scraping article ${url}: ${e.message}`);
    return null;
  }
}

/** Get publication datetime of an article (for cutoff comparison). Returns Date or null. */
async function getArticleDateTime(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': randomUA() },
    });
    if (resp.status !== 200) return null;
    const $ = cheerio.load(resp.data);
    const pubTag = $('p.desktopDetailPTime').first().text().trim();
    if (!pubTag) return null;
    const cleaned = pubTag.replace(/প্রকাশ:?/g, '').trim();
    const iso = convertBengaliDate(cleaned);
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  } catch (_) {
    return null;
  }
}

// ── Location extraction ────────────────────────────────────────────────────
function extractLocation(sectionLabel) {
  // e.g. "jugantor-country-news-dhaka-gazipur-kaliakair"
  if (!sectionLabel.startsWith('jugantor-country-news')) return null;
  const parts = sectionLabel.split('-');
  // jugantor(0)-country(1)-news(2)-division(3)-district(4)-upazilla(5)
  const division  = parts[3] || null;
  const district  = parts[4] || null;
  const upazilla  = parts[5] || null;
  if (!division || !district) return null;
  return { division, district, upazilla };
}

// ── Link extraction + AJAX pagination ─────────────────────────────────────
async function loadMoreArticles(catId, page, sectionKey, lastId) {
  try {
    const ajaxUrl = `${BASE_URL}/ajax/load/categorynews/${catId}/20/${page}/20?lastID=${lastId}`;
    const resp = await axios.get(ajaxUrl, {
      timeout: 15000,
      headers: {
        'User-Agent':      randomUA(),
        'X-Requested-With':'XMLHttpRequest',
        'Accept':          'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'bn-BD,bn;q=0.8,en-US;q=0.5,en;q=0.3',
        'Referer':         `${BASE_URL}/${sectionKey}`,
      },
    });
    if (resp.status !== 200) return [];
    const data = Array.isArray(resp.data) ? resp.data : [];
    const links = data.filter(item => item && item.url).map(item => item.url);
    log(`✅ Extracted ${links.length} article links from AJAX page ${page}`);
    return links;
  } catch (_) {
    return [];
  }
}

function processAndCleanLinks(links, sectionKey) {
  const seen = new Set();
  const result = [];
  for (let link of links) {
    if (link.startsWith('/')) link = BASE_URL + link;
    if (link.includes(sectionKey) && link.includes(BASE_URL) && !seen.has(link)) {
      seen.add(link);
      result.push(link);
    }
  }
  return result;
}

async function extractNewsLinks(categoryUrl, sectionLabel, lastRunTimestamp) {
  try {
    const sectionKey = sectionLabel.replace('jugantor-', '');
    const catId = SECTION_TO_CATEGORY_ID[sectionKey] || SECTION_TO_CATEGORY_ID['country-news'];

    // Determine cutoff datetime
    let cutoffDt;
    if (lastRunTimestamp) {
      cutoffDt = new Date(lastRunTimestamp.replace(' ', 'T'));
    } else {
      const today = new Date();
      cutoffDt = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    }

    log(`\n${'='.repeat(50)}`);
    log(`Extracting news links from: ${categoryUrl}`);
    log(`Looking for articles after: ${lastRunTimestamp || 'today'}`);
    log(`${'='.repeat(50)}\n`);

    // Fetch initial page
    const resp = await axios.get(categoryUrl, {
      timeout: 15000,
      headers: { 'User-Agent': randomUA() },
    });
    if (resp.status !== 200) {
      log(`Failed to fetch ${categoryUrl} (HTTP ${resp.status})`);
      return [];
    }

    const $ = cheerio.load(resp.data);

    // Extract links + article IDs from initial page
    const initialLinks = [];
    const articleIds   = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.startsWith(`${BASE_URL}/${sectionKey}/`)) {
        initialLinks.push(href);
        const lastSeg = href.split('/').pop();
        const id = parseInt(lastSeg, 10);
        if (!isNaN(id)) articleIds.push(id);
      }
    });

    log(`Found ${initialLinks.length} links on initial page`);

    const initialLastId = articleIds.length ? Math.max(...articleIds) : null;
    if (initialLastId) log(`Extracted lastID: ${initialLastId}`);

    const cleanInitial = processAndCleanLinks(initialLinks, sectionKey);
    log(`Cleaned ${cleanInitial.length} links`);

    // Cache dates to avoid re-fetching during sort
    const dateCache = new Map();

    const allLinks = [];
    let consecutiveOld = 0;
    const THRESHOLD = 3;
    let foundOld = false;

    // Check initial page articles
    for (const link of cleanInitial) {
      const dt = await getArticleDateTime(link);
      if (dt) dateCache.set(link, dt);
      if (dt) {
        if (dt < cutoffDt) {
          consecutiveOld++;
          log(`Found article older than cutoff: ${dt.toISOString()} (consecutive: ${consecutiveOld}/${THRESHOLD})`);
          if (consecutiveOld >= THRESHOLD) {
            log(`[STOP] ${THRESHOLD} consecutive old articles — stopping.`);
            foundOld = true; break;
          }
        } else {
          consecutiveOld = 0;
          if (!allLinks.includes(link)) allLinks.push(link);
          log(`[+] Found new article: ${link.split('/').pop()} at ${dt.toISOString()}`);
        }
      } else {
        if (!allLinks.includes(link)) allLinks.push(link);
        log(`[!] Article datetime unavailable, including anyway: ${link.split('/').pop()}`);
      }
      await sleep(100);
    }

    // AJAX pages
    if (catId && initialLastId && !foundOld) {
      for (let page = 1; page <= 50 && !foundOld; page++) {
        log(`\nLoading more articles via AJAX (page ${page})...`);
        const ajaxLinks = await loadMoreArticles(catId, page, sectionKey, initialLastId);
        if (!ajaxLinks.length) { log(`No more articles on AJAX page ${page}`); break; }

        const cleanAjax = processAndCleanLinks(ajaxLinks, sectionKey);
        log(`Loaded ${cleanAjax.length} articles on AJAX page ${page}`);

        for (const link of cleanAjax) {
          const dt = await getArticleDateTime(link);
          if (dt) dateCache.set(link, dt);
          if (dt) {
            if (dt < cutoffDt) {
              consecutiveOld++;
              log(`Found article older than cutoff: ${dt.toISOString()} (consecutive: ${consecutiveOld}/${THRESHOLD})`);
              if (consecutiveOld >= THRESHOLD) {
                log(`[STOP] ${THRESHOLD} consecutive old articles — stopping.`);
                foundOld = true; break;
              }
            } else {
              consecutiveOld = 0;
              if (!allLinks.includes(link)) allLinks.push(link);
              log(`[+] Found new article: ${link.split('/').pop()} at ${dt.toISOString()}`);
            }
          } else {
            if (!allLinks.includes(link)) allLinks.push(link);
            log(`[!] Article datetime unavailable, including anyway: ${link.split('/').pop()}`);
          }
          await sleep(100);
        }
        await sleep(1000);
      }
    }

    // Sort oldest → newest using cached dates
    allLinks.sort((a, b) => {
      const da = dateCache.get(a) || new Date(0);
      const db_ = dateCache.get(b) || new Date(0);
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

    // Resolve category from section label
    const sectionParts = sectionLabel.split('-');
    const categoryKey  = sectionParts[1] || sectionParts[0];
    const category     = SECTION_TO_CATEGORY_ID[categoryKey] || 7;

    const existingId = HEADLINE_TO_ID[headline];
    if (existingId) {
      await updateArticleSuccess(existingId, { headline, isoDate, content, imageName, tags, category, section: sectionLabel });
      log(`✓ Updated existing article (id ${existingId})`, { flush: true });
    } else {
      const newId = await insertArticle({ headline, isoDate, content, imageName, url, tags, category, section: sectionLabel });
      if (newId) {
        HEADLINE_TO_ID[headline] = newId;
        log(`✓ Inserted new article (id ${newId})`, { flush: true });
      } else {
        log('Failed to insert article into DB');
      }
    }

    // If country-news, also store in locations table
    const loc = extractLocation(sectionLabel);
    if (loc) {
      const existing = await getLocationArticleByUrl(url);
      if (!existing) {
        const locId = await insertLocationArticle({
          headline, isoDate, content, imageName, url, tags, category,
          section: sectionLabel, ...loc,
        });
        if (locId) log(`✓ Also stored in locations table (id ${locId})`);
      }
    }

    return true;
  } catch (e) {
    log(`Error processing ${url}: ${e.message}`);
    try {
      await insertFailedUrl(url, sectionLabel, String(e.message));
    } catch (_) {}
    return false;
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function main() {
  let CYCLE_TIME = getCycleTime();
  const cycleStr = CYCLE_TIME < 60 ? `${CYCLE_TIME}s` : `${Math.round(CYCLE_TIME/60)}m`;

  log('='.repeat(70));
  log('JUGANTOR.COM NEWS SCRAPER - MYSQL DATABASE');
  log('='.repeat(70));
  log(`Cycle Time: ${cycleStr}`);
  log('='.repeat(70));

  // Ensure image folder exists
  ensureImgFolder();

  // Load existing headline→id map
  try { await loadHeadlineMap(); } catch (e) { log(`[WARNING] Could not load headline map: ${e.message}`); }

  let lastProcessedDates = loadLastProcessedDates();

  while (true) {
    CYCLE_TIME = getCycleTime();

    // Load active categories
    let categories = [];
    try {
      categories = await getActiveCategories();
    } catch (e) {
      log(`Error loading categories: ${e.message}. Waiting 60s...`);
      await sleep(60000);
      continue;
    }

    if (!categories.length) {
      log('No active Jugantor categories found. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }
    log(`\nMonitoring ${categories.length} active Jugantor categories`);

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
          const section = row.section || 'jugantor-international';
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

      const lastTimestamp = lastProcessedDates[sectionLabel] || null;
      const cycleStart_section = nowStr();

      log(`[STATUS:finding:Searching ${sectionLabel}]`);
      const links = await extractNewsLinks(categoryUrl, sectionLabel, lastTimestamp);

      // Filter out already-in-DB
      const newLinks = [];
      for (const u of links) {
        if (!(await urlExists(u))) newLinks.push(u);
      }
      log(`Found ${links.length} total links (${newLinks.length} new, ${links.length - newLinks.length} already in DB)`);

      for (let idx = 0; idx < newLinks.length; idx++) {
        const url = newLinks[idx];
        log(`[STATUS:extracting:${idx+1}/${newLinks.length}]`);
        log(`\n[INFO] Processing new URL: ${url}`);
        const ok = await processUrl(url, sectionLabel);
        log(ok ? `Successfully processed => ${url}` : `Failed => stored as Failed in DB for retry`);
        await sleep(2000);
      }

      // Save timestamp captured BEFORE extraction (pre-extraction approach)
      lastProcessedDates[sectionLabel] = cycleStart_section;
      saveLastProcessedDates(lastProcessedDates);

      log(`Completed processing for ${sectionLabel}. Pausing briefly...`);
      await sleep(2000);
    }

    const cycleDuration = Math.floor((Date.now() - cycleStart) / 1000);

    // Check autorun
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
