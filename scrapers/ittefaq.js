#!/usr/bin/env node
'use strict';

/**
 * Ittefaq Scraper – Node.js
 * Ported from ittefaq-scraper/scrapittefaq_mysql.py
 * Runs as a child process managed by scraper-manager/server.js
 *
 * Functionality preserved:
 *  - Loads active ittefaq categories from MySQL
 *  - Extracts article links from category page HTML (numeric-path URLs)
 *  - Paginates via Load More API (/api/theme_engine/get_ajax_contents)
 *    with widget_id + page_id; stops at 3 consecutive old articles
 *  - Bengali AM/PM (পূর্বাহ্ন/অপরাহ্ন) + 24-hr date parsing → ISO 8601
 *  - Date extracted from article:published_time meta, time[datetime],
 *    span.tts_time / span.dn, or general date spans
 *  - Downloads images (OG → twitter → figure → content), cleans CDN paths
 *  - Retries failed articles on each cycle (max 10)
 *  - Reads cycle time from scraper_cycle_config.json (default 600 s)
 *  - Emits [STATUS:...] and ✓ article tokens parsed by server.js
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const mysql   = require('mysql2/promise');
const fs      = require('fs');
const path    = require('path');

// Per-session cookie store — ittefaq sets a session cookie and redirects;
// axios's built-in redirect follower doesn't re-run request interceptors so
// we disable auto-redirects and follow them manually with cookies applied.
const cookieStore = new Map();
function _cookieHeader() {
  return cookieStore.size ? [...cookieStore.entries()].map(([k,v])=>`${k}=${v}`).join('; ') : undefined;
}
function _storeSetCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  (Array.isArray(sc) ? sc : [sc]).forEach(c => {
    const [nv] = c.split(';');
    const eq = nv.indexOf('=');
    if (eq > 0) cookieStore.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
  });
}

// ── Paths ──────────────────────────────────────────────────────────────────
const LAST_PROC_FILE = path.join(__dirname, '..', 'last_run', 'ittefaq.json');
const IMG_FOLDER     = path.join(__dirname, '..', 'news_images', 'ittefaq');
const CYCLE_CFG_FILE = path.join(__dirname, '..', 'scraper_cycle_config.json');
const DEFAULT_CYCLE  = 600; // seconds

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
const BASE_URL    = 'https://www.ittefaq.com.bd';
const BASE_DOMAIN = 'www.ittefaq.com.bd';
const LOAD_MORE_API = `${BASE_URL}/api/theme_engine/get_ajax_contents`;

const SECTION_TO_CATEGORY_ID = {
  national:       5,
  politics:       10,
  business:       9,
  'world-news':   6,
  sports:         8,
  entertainment:  14,
  country:        11,
  capital:        12,
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

/**
 * Convert Ittefaq Bengali date to ISO 8601.
 * Handles:
 *   – 24-hr format:   "09 January 2026, 14:35"
 *   – 12-hr AM format: "09 January 2026, 03:35 পূর্বাহ্ন"
 *   – 12-hr PM format: "09 January 2026, 03:35 অপরাহ্ন"
 */
function toISO(bengaliDate) {
  try {
    let s = bn2en(String(bengaliDate).normalize('NFC').trim());

    // Replace Bengali month names
    for (const [bn, en] of Object.entries(BN_MONTHS)) {
      if (s.includes(bn)) { s = s.replace(bn, en); break; }
    }

    // Detect & strip AM/PM markers
    let is12hr = false;
    let isPM   = false;
    if (s.includes('অপরাহ্ন') || s.includes('পিএম')) {
      s = s.replace('অপরাহ্ন', '').replace('পিএম', '').trim();
      is12hr = true; isPM = true;
    } else if (s.includes('পূর্বাহ্ন') || s.includes('এএম')) {
      s = s.replace('পূর্বাহ্ন', '').replace('এএম', '').trim();
      is12hr = true; isPM = false;
    }

    // Normalise whitespace
    s = s.replace(/\s+/g, ' ').trim();

    // Parse "DD Month YYYY, HH:MM"
    const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const mo = MONTH_IDX[m[2]];
    if (!mo) return null;
    let hr = +m[4];
    const mn = +m[5];

    if (is12hr) {
      if (isPM && hr !== 12) hr += 12;
      else if (!isPM && hr === 12) hr = 0;
    }
    return `${m[3]}-${pad2(mo)}-${pad2(+m[1])}T${pad2(hr)}:${pad2(mn)}:00`;
  } catch { return null; }
}

// ── Cycle time ─────────────────────────────────────────────────────────────
function getCycleTime() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CYCLE_CFG_FILE, 'utf8'));
    if (cfg.scrapers && cfg.scrapers.ittefaq != null) return Number(cfg.scrapers.ittefaq);
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
    "SELECT category_url, section_label FROM categories WHERE is_active=1 AND site='ittefaq' ORDER BY section_label"
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
      [headline, headline, pubDt, content, imageName, sourceUrl, sourceSite, tags, String(category), section, 'Success', 1]
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
    [headline, headline, pubDt, content, imageName, sourceSite, tags, String(category), section, id]
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
    "SELECT * FROM articles WHERE scraping_status='Failed' AND processing_count < 10 AND section LIKE 'ittefaq-%'"
  );
}

async function getAutorun() {
  try {
    const rows = await dbQuery("SELECT autorun FROM scraper_autorun WHERE site='ittefaq' LIMIT 1");
    return rows[0] ? rows[0].autorun : 1;
  } catch { return 1; }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function buildHeaders(extra = {}) {
  return {
    'User-Agent':      randomUA(),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    ...extra,
  };
}

async function fetchPage(url, _hops = 0) {
  if (_hops > 10) throw new Error('Maximum number of redirects exceeded');
  const cookie = _cookieHeader();
  const resp = await axios.get(url, {
    headers:      { ...buildHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
    timeout:      15000,
    responseType: 'text',
    maxRedirects: 0,
    validateStatus: s => s < 500,
  });
  _storeSetCookie(resp.headers);
  if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
    const next = resp.headers.location.startsWith('http')
      ? resp.headers.location
      : new URL(resp.headers.location, url).href;
    return fetchPage(next, _hops + 1);
  }
  return resp.data;
}

// ── Article date cache ─────────────────────────────────────────────────────
const articleDateCache = new Map();

/**
 * Fetch article page, extract publication datetime → Date object. Cached.
 * Tries: article:published_time meta → time[datetime] → span.tts_time / span.dn → date spans
 */
async function getArticleDate(url) {
  if (articleDateCache.has(url)) return articleDateCache.get(url);

  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);
    let result = null;

    // Method 1: article:published_time meta
    const ogTime = $('meta[property="article:published_time"]').attr('content');
    if (ogTime) {
      try {
        result = new Date(ogTime.replace('Z', '+00:00'));
        if (isNaN(result)) result = null;
        else result = new Date(result.getTime() - result.getTimezoneOffset() * 60000); // strip TZ
      } catch { result = null; }
    }

    // Method 2: time[datetime] attribute
    if (!result) {
      const dtAttr = $('time[datetime]').first().attr('datetime');
      if (dtAttr) {
        try {
          const d = new Date(dtAttr.replace('Z', '+00:00'));
          if (!isNaN(d)) result = d;
        } catch { /* ignore */ }
      }
      if (!result) {
        const timeText = $('time').first().text().trim();
        if (timeText) {
          const iso = toISO(timeText);
          if (iso) result = new Date(iso);
        }
      }
    }

    // Method 3: span.tts_time or span.dn
    if (!result) {
      let dateText = $('span.tts_time').first().text().trim() ||
                     $('span.dn').first().text().trim();
      if (dateText) {
        // Strip label like "প্রকাশ :" (first colon if within first 20 chars)
        const colonIdx = dateText.indexOf(':');
        if (colonIdx !== -1 && colonIdx < 20) {
          dateText = dateText.slice(colonIdx + 1).trim();
        }
        const iso = toISO(dateText);
        if (iso) result = new Date(iso);
      }
    }

    // Method 4: spans with 'date' or 'time' in class name
    if (!result) {
      $('span').each((_, el) => {
        if (result) return;
        const cls = ($(el).attr('class') || '').toLowerCase();
        if (!cls.includes('date') && !cls.includes('time')) return;
        const text = $(el).text().trim();
        if (!text) return;
        const iso = toISO(text);
        if (iso) result = new Date(iso);
      });
    }

    articleDateCache.set(url, result);
    return result;
  } catch {
    articleDateCache.set(url, null);
    return null;
  }
}

// ── Link extraction from HTML ──────────────────────────────────────────────
function extractArticleLinksFromHtml(html) {
  const links = [];
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.includes('/')) return;

      let urlPath;
      if (href.startsWith('http')) {
        if (!href.includes('ittefaq.com.bd')) return;
        urlPath = href.split('ittefaq.com.bd').slice(-1)[0];
      } else if (href.startsWith('//')) {
        if (!href.includes('ittefaq.com.bd')) return;
        urlPath = href.split('ittefaq.com.bd').slice(-1)[0];
      } else {
        urlPath = href;
      }

      const parts = urlPath.split('/').filter(Boolean);
      if (!parts.length || !/^\d+$/.test(parts[0])) return;

      let fullUrl;
      if (href.startsWith('http'))       fullUrl = href;
      else if (href.startsWith('//'))    fullUrl = 'https:' + href;
      else                               fullUrl = BASE_URL + href;

      if (!links.includes(fullUrl)) links.push(fullUrl);
    });
  } catch (e) {
    log(`Error extracting article links: ${e.message}`);
  }
  return links;
}

/** Extract widget_id and page_id from category page HTML for the Load More API. */
function extractWidgetAndPageId(html) {
  let widgetId = null, pageId = null;

  const btnMatch = html.match(/id="ajax_load_more_(\d+)_btn"/);
  if (btnMatch) widgetId = btnMatch[1];

  const patterns = [
    /pageid\s*=\s*["'](\d+)['"]/i,
    /page_id["']?\s*[:=]\s*["']?(\d+)/,
    /pageId["']?\s*[:=]\s*["']?(\d+)/,
    /data-page-id["']?\s*[:=]\s*["']?(\d+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) { pageId = m[1]; break; }
  }

  return { widgetId, pageId };
}

// ── Extract news links from category page ──────────────────────────────────
async function extractNewsLinks(categoryUrl, sectionLabel, lastRunTimestamp) {
  let cutoff;
  if (!lastRunTimestamp) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d;
    log(`No last run timestamp — scraping today's articles only (after ${cutoff.toISOString().slice(0,19)})`);
  } else {
    cutoff = new Date(lastRunTimestamp.replace(' ', 'T'));
    log(`Looking for articles published after: ${lastRunTimestamp}`);
  }

  try {
    log(`Fetching category page: ${categoryUrl}`);
    let html;
    try {
      html = await fetchPage(categoryUrl);
    } catch (e) {
      log(`Failed to fetch category page: ${e.message}`);
      return [];
    }

    const page1Links = extractArticleLinksFromHtml(html);
    log(`Found ${page1Links.length} articles on initial page`);

    const allLinks = [];
    let consecutiveOld = 0;

    for (const link of page1Links) {
      const dt = await getArticleDate(link);
      const articleId = link.split('/').slice(-2)[0];
      if (dt) {
        if (dt < cutoff) {
          consecutiveOld++;
          log(`[Page 1] Old article (${consecutiveOld}/3 consecutive, before cutoff): ${dt.toISOString().slice(0,19)}`);
          if (consecutiveOld >= 3) {
            log('[Page 1] 3 consecutive old articles found — stopping page 1 scan');
            break;
          }
        } else {
          consecutiveOld = 0;
          allLinks.push(link);
          log(`[Page 1] New article: ID ${articleId} at ${dt.toISOString().slice(0,19)}`);
        }
      } else {
        consecutiveOld = 0;
        allLinks.push(link);
        log(`[Page 1] Article (no date): ID ${articleId}`);
      }
      await sleep(50);
    }
    log(`✓ Page 1: ${allLinks.length}/${page1Links.length} articles after date filter`);

    // Extract widget/page IDs for Load More API
    const { widgetId, pageId } = extractWidgetAndPageId(html);
    if (!widgetId || !pageId) {
      log(`⚠️ Could not extract widget_id or page_id. Using page 1 articles only.`);
      log(`   widget_id=${widgetId}, page_id=${pageId}`);
    } else {
      log(`✓ Extracted widget_id=${widgetId}, page_id=${pageId}`);
      log(`✓ Pagination enabled via Load More API`);

      let start = 20;
      const count = 20;
      let apiCalls = 0;
      const maxApiCalls = 19; // max_pages - 1
      let stopPagination = false;

      while (apiCalls < maxApiCalls && !stopPagination) {
        log(`Fetching via Load More API (start=${start}, count=${count})`);
        try {
          const resp = await axios.get(LOAD_MORE_API, {
            params: {
              widget:       widgetId,
              start:        String(start),
              count:        String(count),
              page_id:      pageId,
              subpage_id:   '0',
              author:       '0',
              tags:         '',
              archive_time: '',
              filter:       '',
            },
            headers: { ...buildHeaders(), 'Accept': 'application/json, text/html', ...(_cookieHeader() ? { Cookie: _cookieHeader() } : {}) },
            timeout: 15000,
          });

          const data     = resp.data;
          const htmlContent = typeof data === 'object' ? (data.html || '') : '';
          const finished = typeof data === 'object' ? (data.finished || false) : false;

          if (!htmlContent) {
            log('No more content from API');
            break;
          }

          const pageLinks = extractArticleLinksFromHtml(htmlContent);
          const newLinks  = pageLinks.filter(l => !allLinks.includes(l));
          log(`Found ${newLinks.length} new articles from API call #${apiCalls + 1}`);

          if (!newLinks.length) {
            log('No new articles in this batch, stopping pagination');
            break;
          }

          let newInBatch = 0, oldInBatch = 0;
          for (const link of newLinks) {
            const dt = await getArticleDate(link);
            const articleId = link.split('/').slice(-2)[0];
            if (dt) {
              if (dt < cutoff) {
                consecutiveOld++;
                oldInBatch++;
                log(`[Old] Article ID ${articleId} at ${dt.toISOString().slice(0,19)} (${consecutiveOld}/3 consecutive, before cutoff)`);
                if (consecutiveOld >= 3) {
                  log('3 consecutive old articles found — stopping pagination');
                  stopPagination = true;
                  break;
                }
              } else {
                consecutiveOld = 0;
                allLinks.push(link);
                newInBatch++;
                log(`[+] New article: ID ${articleId} at ${dt.toISOString().slice(0,19)}`);
              }
            } else {
              consecutiveOld = 0;
              allLinks.push(link);
              newInBatch++;
              log(`[!] Article datetime unavailable, including: ID ${articleId}`);
            }
            await sleep(50);
          }

          log(`✓ Batch summary: ${newInBatch} new, ${oldInBatch} old`);

          if (stopPagination) break;

          if (oldInBatch > 0) {
            log('✓ Found old articles in batch — stopping pagination (reached cutoff point)');
            break;
          }

          if (finished) {
            log('API indicates no more content (finished=true)');
            break;
          }

          start += count;
          apiCalls++;
          await sleep(1000);
        } catch (e) {
          log(`Error fetching from API (start=${start}): ${e.message}`);
          break;
        }
      }
    }

    // Sort oldest to newest
    const sorted = await sortByDate(allLinks);
    log(`✓ Found total of ${sorted.length} new articles after last run`);
    return sorted;

  } catch (e) {
    log(`Error extracting news links from ${categoryUrl}: ${e.message}`);
    return [];
  }
}

async function sortByDate(urls) {
  const pairs = [];
  for (const url of urls) {
    const dt = await getArticleDate(url);
    pairs.push([url, dt ? dt.getTime() : 0]);
  }
  pairs.sort((a, b) => a[1] - b[1]);
  log(`Sorted ${pairs.length} URLs by publication date (oldest to newest)`);
  return pairs.map(p => p[0]);
}

// ── Image download ─────────────────────────────────────────────────────────
/** Clean CDN image URL — remove resize/crop path prefix and watermark query params. */
function cleanImageUrl(raw) {
  if (!raw) return null;
  let url = raw;
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = BASE_URL + url;

  // Remove CDN watermark/resize prefix and strip query params
  if (url.includes('uploads/media/')) {
    const parts = url.split('uploads/media/');
    let base = parts[0];
    if (base.includes('/cache/images/')) {
      base = base.split('/cache/images/')[0];
    }
    const filenamePart = parts[1].split('?')[0];
    return base + '/uploads/media/' + filenamePart;
  }
  return url.split('?')[0];
}

async function downloadImage(imgUrl, articleUrl) {
  try {
    if (!imgUrl) return 'Not Available';

    const resp = await axios.get(imgUrl, {
      headers:      { 'User-Agent': randomUA() },
      responseType: 'arraybuffer',
      timeout:      15000,
    });

    // Generate unique filename
    const suffix    = Math.random().toString(36).slice(2, 10);
    const imageName = `ittefaq_${suffix}.jpg`;
    const imgPath   = path.join(IMG_FOLDER, imageName);
    fs.writeFileSync(imgPath, Buffer.from(resp.data));
    log(`✓ Downloaded image: ${imageName}`);
    return imageName;
  } catch (e) {
    log(`Failed to download image from ${imgUrl}: ${e.message}`);
    return 'Not Available';
  }
}

// ── Scrape a single article page ───────────────────────────────────────────
async function scrapeArticleContent(url) {
  try {
    await sleep(500);
    const html = await fetchPage(url);
    const $    = cheerio.load(html);

    // Headline
    const headline = $('h1.title').text().trim() || null;

    // Date
    const dt     = await getArticleDate(url);
    const isoDate = dt ? dt.toISOString().slice(0,19) : 'Not Available';

    // Content
    const contentParts = [];
    $('div.content_detail_each_group p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) contentParts.push(t);
    });
    const content = contentParts.length ? contentParts.join(' ') : null;

    // Image — try 4 sources
    let imageUrl = null;
    const ogImg = $('meta[property="og:image"]').attr('content');
    if (ogImg) imageUrl = cleanImageUrl(ogImg);

    if (!imageUrl) {
      const twImg = $('meta[name="twitter:image"]').attr('content');
      if (twImg) imageUrl = cleanImageUrl(twImg);
    }
    if (!imageUrl) {
      const figSrc = $('figure img').first().attr('src');
      if (figSrc) imageUrl = figSrc;
    }
    if (!imageUrl) {
      const divSrc = $('div.content_detail_each_group img').first().attr('src');
      if (divSrc) imageUrl = divSrc;
    }

    const imageName = imageUrl ? await downloadImage(imageUrl, url) : 'Not Available';

    // Tags
    const tagList = [];
    $('div.content_tags a').each((_, el) => {
      const t = $(el).text().trim(); if (t) tagList.push(t);
    });
    const tags = tagList.length ? tagList.join(', ') : 'Not Available';

    if (!headline || !content) {
      const articleId = url.split('/').slice(-2)[0];
      log(`Missing headline or content for article ${articleId}`);
      log(`  Headline present: ${Boolean(headline)}, Content present: ${Boolean(content)}`);
      return null;
    }

    log(`✓ Scraped: headline=${headline.length} chars, content=${content.length} chars, tags=${tags.slice(0,50)}`);
    return { headline, date: isoDate, content, imageName, tags, url };

  } catch (e) {
    const articleId = url.split('/').slice(-2)[0];
    if (e.response) {
      log(`Failed to fetch article ${articleId} (HTTP ${e.response.status})`);
    } else if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
      log(`Timeout error scraping article ${articleId}`);
    } else {
      log(`Error scraping article ${articleId}: ${e.message}`);
    }
    return null;
  }
}

// ── Category ID from section label ─────────────────────────────────────────
function getCategoryId(sectionLabel) {
  const parts = sectionLabel.split('-');
  const key   = parts.length > 1 ? parts[1] : parts[0];
  return SECTION_TO_CATEGORY_ID[key] || 7;
}

// ── Process a single article URL ───────────────────────────────────────────
async function processUrl(url, sectionLabel, existingRow) {
  if (!existingRow) existingRow = await getArticleByUrl(url);
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
  log(`Processing article ID ${articleId} from Ittefaq (section: ${sectionLabel})`);

  const data = await scrapeArticleContent(url);
  if (!data) {
    log(`Failed to scrape article: ${url}`);
    if (existingRow) await updateArticleFailed(existingRow.id, 'Failed to scrape content');
    else await insertFailedUrl(url, BASE_DOMAIN, sectionLabel, 'Failed to scrape content');
    return false;
  }

  const category = getCategoryId(sectionLabel);
  const articleData = {
    headline:   data.headline,
    publishedAt: data.date,
    content:    data.content,
    imageName:  data.imageName,
    sourceUrl:  url,
    sourceSite: BASE_DOMAIN,
    tags:       data.tags,
    category,
    section:    sectionLabel,
  };

  try {
    if (existingRow) {
      await updateArticleSuccess({ id: existingRow.id, ...articleData });
      log(`✓ Updated existing article (id ${existingRow.id})`);
    } else {
      const newId = await insertArticle(articleData);
      if (newId) {
        log(`✓ Inserted new article (id ${newId})`);
      } else {
        log('Article already exists in database (duplicate URL)');
      }
    }
    return true;
  } catch (e) {
    log(`Error storing article: ${e.message}`);
    try { await insertFailedUrl(url, BASE_DOMAIN, sectionLabel, e.message); } catch { /* ignore */ }
    return false;
  }
}

// ── Main scraping loop ─────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(IMG_FOLDER, { recursive: true });

  log('='.repeat(70));
  log('ITTEFAQ.COM.BD NEWS SCRAPER - Node.js');
  log('='.repeat(70));

  let lastProcessed = loadLastProcessed();
  log(`Last processed timestamps: ${JSON.stringify(lastProcessed)}`);

  let cycleTime = getCycleTime();
  log(`Cycle Time: ${cycleTime}s`);

  while (true) {
    cycleTime = getCycleTime();
    articleDateCache.clear();

    let categories;
    try {
      categories = await getActiveCategories();
    } catch (e) {
      log(`Error loading categories: ${e.message}`);
      categories = [];
    }

    if (!categories.length) {
      log('No active Ittefaq categories found in database. Waiting 60 seconds...');
      await sleep(60000);
      continue;
    }

    log(`\nMonitoring ${categories.length} active Ittefaq categories`);

    // Retry failed articles
    log('[STATUS:finding:Checking for failed articles]');
    let failedRows = [];
    try { failedRows = await getFailedArticles(); } catch (e) { log(`Error loading failed articles: ${e.message}`); }
    if (failedRows.length) log(`Found ${failedRows.length} failed Ittefaq URLs to retry`);
    for (let i = 0; i < failedRows.length; i++) {
      const row = failedRows[i];
      const url = row.source_url;
      if (!url) continue;
      log(`[${i+1}/${failedRows.length}] Retrying URL (attempt ${(row.processing_count || 0) + 1}/10): ${url}`);
      const ok = await processUrl(url, row.section || 'ittefaq-national', row);
      log(ok ? '✓ Successfully processed on retry' : '✗ Still failed');
      await sleep(2000);
    }

    const cycleStartMs = Date.now();
    log(`\n${'='.repeat(70)}`);
    log(`CYCLE START: ${nowStr()}`);
    log('='.repeat(70));

    for (const { category_url, section_label } of categories) {
      log(`\n${'='.repeat(70)}`);
      log(`Processing: ${section_label}`);
      log(`URL: ${category_url}`);
      log('='.repeat(70));

      const lastTimestamp = lastProcessed[section_label] || null;
      log(lastTimestamp ? `Last Run: ${lastTimestamp}` : 'Last Run: Never (First time)');

      const cycSectionStart = nowStr();
      log(`[STATUS:finding:Searching ${section_label}]`);

      const links    = await extractNewsLinks(category_url, section_label, lastTimestamp);
      const newLinks = [];
      for (const url of links) {
        if (!(await urlExists(url))) newLinks.push(url);
      }
      log(`Found ${links.length} total links since last run (${newLinks.length} new, ${links.length - newLinks.length} already in DB)`);

      for (let i = 0; i < newLinks.length; i++) {
        const url = newLinks[i];
        log(`[STATUS:extracting:${i+1}/${newLinks.length}]`);
        log(`\n[INFO] Processing new URL: ${url}`);
        const ok = await processUrl(url, section_label, null);
        log(ok ? `Successfully processed => ${url}` : `Failed => stored as Failed in DB for retry`);
        await sleep(2000);
      }

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

main().catch(e => {
  process.stderr.write(`Fatal error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
