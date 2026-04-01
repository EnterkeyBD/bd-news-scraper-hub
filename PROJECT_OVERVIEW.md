# D K Update 2388 - Complete Project Overview

## 📋 Project Summary
**D K Update 2388** is a comprehensive news aggregation system that scrapes articles from 6 major Bangladeshi news websites, stores them in a centralized MySQL database, and provides web-based management dashboards.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CENTRALIZED SYSTEM                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │        MySQL Database (Remote Server)                  │  │
│  │        Host: 103.213.38.238                           │  │
│  │        DB: siamvidb_scraptestg                        │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Tables:                                               │  │
│  │  • articles (main content storage)                    │  │
│  │  • categories (scraping configuration)                │  │
│  │  • locations (for regional news tracking)            │  │
│  └───────────────────────────────────────────────────────┘  │
│                            ↑                                  │
│                            │                                  │
│  ┌─────────────────────────┴─────────────────────────────┐  │
│  │              9 Independent Scrapers                    │  │
│  │  1. Kalbela      4. BDNews24     7. DhakaPost         │  │
│  │  2. Desh TV      5. Prothom Alo  8. Jagonews24        │  │
│  │  3. Jugantor     6. Ittefaq      9. Samakal           │  │
│  └────────────────────────────────────────────────────────┘  │
│                            ↑                                  │
│                            │                                  │
│  ┌─────────────────────────┴─────────────────────────────┐  │
│  │           Management & Monitoring Systems              │  │
│  │  • Scraper Manager (Node.js Dashboard)               │  │
│  │  • Category Dashboard (Category Management)           │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
D K update 2388/
├── kalbela-scraper/          # Kalbela.com scraper
├── desh-scraper/             # Desh.tv scraper
├── jugantor-scraper/         # Jugantor.com scraper
├── ittefaq-scraper/          # Ittefaq.com scraper
├── bdnews24-scraper/         # BDNews24.com scraper
├── prothomalo-scraper/       # Prothom Alo scraper
├── dhakapost-scraper/        # DhakaPost.com scraper
├── jagonews24-scraper/       # Jagonews24.com scraper
├── samakal-scraper/          # Samakal.com scraper (NEW)
├── kalbela-desh-scraper/     # (Legacy - combined scraper)
├── scraper-manager/          # Node.js management dashboard
├── category-dashboard/       # Category management UI
├── event-clustering/         # AI-powered event clustering
├── scrapper-449513-*.json    # Google Cloud credentials
└── Documentation files       # Logic analysis & summaries
```

---

## 🤖 Individual Scrapers

### 1. **Kalbela Scraper** (`kalbela-scraper/`)
- **Source**: https://www.kalbela.com
- **Language**: Python
- **Main Script**: `scrapkalbela_mysql.py` (785 lines)
- **Special Features**:
  - Bengali date conversion (12-hour AM/PM format)
  - First paragraph only extraction
  - 4-layer HTML extraction (lead, sub-lead, more news, common leads)
  - AJAX pagination with smart stopping
  
### 2. **Desh TV Scraper** (`desh-scraper/`)
- **Source**: https://www.desh.tv
- **Language**: Python
- **Main Script**: `scrapdesh_mysql.py` (785 lines)
- **Special Features**:
  - Bengali date conversion (24-hour format)
  - All paragraphs extraction (removes last word - watermark)
  - Same structure as Kalbela
  
### 3. **Jugantor Scraper** (`jugantor-scraper/`)
- **Source**: https://www.jugantor.com
- **Language**: Python
- **Main Script**: `scrapjugantor_mysql.py`
- **Special Features**:
  - District/division tracking for regional news
  - Country-news hierarchical structure (Division → District → Upazilla)
  
### 4. **Ittefaq Scraper** (`ittefaq-scraper/`)
- **Source**: https://www.ittefaq.com
- **Language**: Python
- **Main Script**: `scrapittefaq_mysql.py`
- **Special Features**:
  - Similar structure to Jugantor
  - Regional news tracking
  
### 5. **BDNews24 Scraper** (`bdnews24-scraper/`)
- **Source**: https://bangla.bdnews24.com
- **Language**: Python
- **Main Script**: `scrapbdnews24_mysql.py`
- **Special Features**:
  - Category ID-based scraping
  - Tag/keyword extraction
  
### 6. **Prothom Alo Scraper** (`prothomalo-scraper/`)
- **Source**: https://www.prothomalo.com
- **Language**: Python
- **Main Script**: `scrapprothomalo_mysql.py`
- **Special Features**:
  - API-based scraping using `/api/v1/collections/{category}`
  - Offset-based pagination
  - Most efficient scraper (uses official API)

### 7. **DhakaPost Scraper** (`dhakapost-scraper/`)
- **Source**: https://www.dhakapost.com
- **Language**: Python
- **Main Script**: `scrapdhakapost_mysql.py`
- **Special Features**:
  - Multiple pagination methods
  - Cloudflare bypass mechanisms
  - Session-based approach

### 8. **Jagonews24 Scraper** (`jagonews24-scraper/`)
- **Source**: https://www.jagonews24.com
- **Language**: Python
- **Main Script**: `scrapjagonews24_mysql.py`
- **Special Features**:
  - Standard HTML parsing
  - Category-based scraping

### 9. **Samakal Scraper** (`samakal-scraper/`) ⭐ NEW
- **Source**: https://samakal.com
- **Language**: Python
- **Main Script**: `scrapsamakal_mysql.py`
- **Special Features**:
  - Bengali date parsing support
  - Full paragraph extraction
  - Image optimization
  - Retry logic with exponential backoff
  - Configurable cycle times

---

## 🎯 Common Features Across All Scrapers

### Date Handling
- ✅ Bengali to English date conversion
- ✅ ISO 8601 format standardization
- ✅ Target date filtering (only scrape articles from specific dates)
- ✅ Timestamp-based filtering for partial days

### Retry Logic
- ✅ Max 10 attempts per article
- ✅ `scraping_status`: 'Success' or 'Failed'
- ✅ Automatic retry on next cycle
- ✅ Processing counter incrementation

### Content Processing
- ✅ Headline extraction
- ✅ Publication date extraction
- ✅ Full content extraction
- ✅ Image download and optimization (resize, sharpen, compress)
- ✅ Category/section tagging

### Monitoring Loop
- ✅ Phase 1: Retry failed URLs
- ✅ Phase 2: Update current date
- ✅ Phase 3: Check categories for new articles
- ✅ Phase 4: Wait 600 seconds (10 minutes)
- ✅ Continuous operation

### Database Operations
- ✅ Duplicate URL prevention
- ✅ Failed article tracking
- ✅ Category-based organization
- ✅ Image storage with filenames

---

## 🗄️ Database Schema

### Articles Table
```sql
CREATE TABLE articles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    headline TEXT,
    actual_headline TEXT,
    published_at DATETIME NULL,
    content LONGTEXT,
    image_name VARCHAR(512),
    source_url TEXT UNIQUE,
    source_site VARCHAR(255),
    tags TEXT,
    category VARCHAR(255),
    section VARCHAR(255),
    scraping_status VARCHAR(50) DEFAULT 'Success',
    processing_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_source_url (source_url(255))
)
```

### Categories Table
```sql
CREATE TABLE categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_url TEXT NOT NULL,
    section_label VARCHAR(255) NOT NULL UNIQUE,
    site VARCHAR(50) NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_site (site),
    INDEX idx_is_active (is_active),
    INDEX idx_section_label (section_label)
)
```

### Locations Table (Jugantor, Ittefaq, Kalbela-Desh only)
```sql
CREATE TABLE locations (
    -- Same as articles table PLUS:
    division VARCHAR(255) NOT NULL,
    district VARCHAR(255) NOT NULL,
    upazilla VARCHAR(255),
    INDEX idx_division_district (division, district)
)
```

---

## 🖥️ Management Dashboards

### 1. Scraper Manager (`scraper-manager/`)
**Technology**: Node.js + Express + Socket.IO  
**Port**: 3000  
**URL**: http://localhost:3000

**Features**:
- ✅ Start/Stop/Restart scrapers
- ✅ Real-time output logs
- ✅ Live status monitoring
- ✅ Statistics tracking (articles processed, errors, uptime)
- ✅ WebSocket updates (5-second intervals)
- ✅ Category last-run tracking
- ✅ Process management

**API Endpoints**:
- `GET /api/scrapers` - Get all scraper status
- `POST /api/scrapers/:id/start` - Start scraper
- `POST /api/scrapers/:id/stop` - Stop scraper
- `POST /api/scrapers/:id/restart` - Restart scraper
- `GET /api/categories` - Get all categories
- `POST /api/categories` - Add new category ⭐ NEW
- `PUT /api/categories/:id` - Update category ⭐ NEW
- `DELETE /api/categories/:id` - Delete category ⭐ NEW
- `PATCH /api/categories/:id/toggle` - Toggle category status
- `PATCH /api/categories/bulk/:action` - Bulk enable/disable

### 2. Category Dashboard (`category-dashboard/`)
**Technology**: Node.js + Express + Vanilla JS  
**Port**: 3000 (separate instance)  
**URL**: http://localhost:3000

**Features**:
- ✅ Hierarchical tree view of categories
- ✅ Enable/disable categories
- ✅ Bulk operations
- ✅ Search functionality
- ✅ Site filtering
- ✅ Status filtering (all/active/disabled)
- ✅ Real-time statistics
- ✅ Add new categories ⭐ NEW
- ✅ Edit categories ⭐ NEW
- ✅ Delete categories ⭐ NEW

---

## 🔧 Technology Stack

### Backend (Scrapers)
- **Python 3.x**
- **Libraries**:
  - `requests` - HTTP requests
  - `beautifulsoup4` - HTML parsing
  - `mysql-connector-python` - Database connectivity
  - `Pillow` - Image processing
  - `fake-useragent` - User agent rotation
  - `rich` - Terminal formatting

### Backend (Dashboards)
- **Node.js**
- **Express.js** - Web framework
- **Socket.IO** - Real-time communication
- **mysql2** - MySQL driver
- **Winston** - Logging
- **node-cron** - Scheduled tasks

### Frontend
- **Vanilla JavaScript** - No framework dependencies
- **Modern CSS** - Gradients, animations, responsive design
- **Fetch API** - AJAX requests

### Database
- **MySQL 5.7+**
- **Remote Server**: 103.213.38.238
- **Character Set**: utf8mb4 (full Unicode support)

---

## 🚀 How to Run

### Start Individual Scraper
```bash
cd kalbela-scraper
python start.py
```

### Start Scraper Manager
```bash
cd scraper-manager
npm install
npm start
```

### Start Category Dashboard
```bash
cd category-dashboard
npm install
npm start
```

---

## 📊 Data Flow

1. **Category Configuration** → Categories Dashboard
   - Admin adds/manages categories via web UI
   - Categories stored in database with `is_active` flag

2. **Scraping Process** → Individual Scrapers
   - Load active categories from database
   - Extract links from category pages
   - Filter by date (only target date articles)
   - Extract full article content
   - Download and process images
   - Store in database

3. **Retry Mechanism**
   - Failed articles marked with `scraping_status='Failed'`
   - `processing_count` incremented on each attempt
   - Retried automatically on next cycle (max 10 attempts)

4. **Monitoring** → Scraper Manager
   - Real-time process status
   - Live log streaming
   - Statistics aggregation
   - Control interface

---

## 📈 Key Metrics

- **Total Scrapers**: 9 active + 1 legacy
- **Target Sites**: 9 major Bangladeshi news portals
- **Update Frequency**: 10-minute cycles (configurable per scraper)
- **Max Retries**: 10 attempts per article
- **Image Optimization**: 800x600 max, 85% JPEG quality
- **Database**: Centralized MySQL with 3 main tables

---

## 🔑 Configuration

### Database Connection (All scrapers)
```python
{
    'host': "103.213.38.238",
    'port': 3306,
    'database': "siamvidb_scraptestg",
    'user': "siamvidb_scraptestg",
    'password': "HuHmf!w=E]%I=3L&"
}
```

### Scraper Locations
- Kalbela: `../kalbela-scraper`
- Desh: `../desh-scraper`
- Jugantor: `../jugantor-scraper`
- Ittefaq: `../ittefaq-scraper`
- BDNews24: `../bdnews24-scraper`
- Prothom Alo: `../prothomalo-scraper`
- DhakaPost: `../dhakapost-scraper`
- Jagonews24: `../jagonews24-scraper`
- Samakal: `../samakal-scraper` ⭐ NEW

---

## 🎨 Recent Updates

### ⭐ NEW: Samakal Scraper Added (February 2026)
- New fully independent scraper for Samakal.com
- Integrated with scraper manager dashboard
- Full CRUD support via management interfaces
- Bengali date parsing and image optimization
- Configurable cycle times
- Rechecker support for failed articles

### ⭐ Add Category Feature
- Added "➕ Add Category" button to both dashboards
- Full CRUD API endpoints (Create, Read, Update, Delete)
- Beautiful modal dialog with form validation
- Duplicate detection
- Success/error notifications
- Enhanced error logging and debugging

---

## 📝 Development Notes

### Code Quality
- ✅ Consistent structure across scrapers
- ✅ Comprehensive error handling
- ✅ Detailed logging
- ✅ Database connection pooling
- ✅ Modular design (db.py separate from scraper logic)

### Known Issues
- ⚠️ Database connection timeout (ECONNRESET) - Fixed with keepalive
- ⚠️ Some legacy JSON date files have formatting issues

### Future Enhancements
- [ ] Add authentication to dashboards
- [ ] Export categories to CSV/JSON
- [ ] Duplicate article detection across sites
- [ ] Advanced analytics and reporting
- [ ] Notification system for errors
- [ ] Docker containerization

---

## 🤝 Support

For issues or questions:
1. Check server logs: `scraper-manager/logs/`
2. Check individual scraper logs
3. Verify database connectivity
4. Check browser console for frontend errors

---

## 📚 Documentation Files

- `KALBELA_DESH_LOGIC_ANALYSIS.md` - Detailed logic analysis of Kalbela/Desh scrapers
- `KALBELA_DESH_SPLIT_SUMMARY.md` - Split implementation summary
- Individual `README.md` files in each scraper directory
- `ADD_CATEGORY_FEATURE.md` - New feature documentation

---

**Last Updated**: January 24, 2026  
**Version**: 2388  
**Status**: Production Active ✅
