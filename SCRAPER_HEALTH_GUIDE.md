# 🏥 Scraper Health Monitoring System

## ✅ System Status: READY & RUNNING

**Dashboard**: http://localhost:3002  
**Status**: ✓ Active  
**Database**: ✓ Initialized  
**Server**: ✓ Running on Port 3002

> **Quick Access**: The dashboard is currently running in your terminal and accessible at the URL above. The dashboard auto-refreshes every 10 seconds.
> **Note**: Port 3002 is used to avoid conflict with scraper-manager on port 3001.

---

## 🎯 What This System Does

When you run multiple scrapers, it's hard to know which one is having problems (403 errors, 500 errors, timeouts, crashes, etc.). This health monitoring system solves that by:

1. **Tracking all scrapers** in one centralized dashboard
2. **Automatically detecting errors** (HTTP errors, timeouts, crashes)
3. **Logging everything** (successes, warnings, errors with details)
4. **Real-time updates** (refreshes every 10 seconds)
5. **Visual alerts** (red cards for errors, green for success)

---

## 🚀 How to Use (Super Simple!)

### For Each Scraper, Add 3 Things:

**1. Import at the top:**
```python
import sys, os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'scraper-health'))
from health_monitor import ScraperHealthMonitor
import traceback
```

**2. Create monitor:**
```python
monitor = ScraperHealthMonitor("bdnews24")  # Use your scraper name
```

**3. Wrap your main code:**
```python
monitor.start_run()
try:
    # Your scraping code here
    for article in articles:
        # Process article
        monitor.increment_articles()  # Count each article
    monitor.end_run(success=True)
except Exception as e:
    monitor.log_critical(f"Error: {str(e)}", error_code="CRASH", 
                        error_details=traceback.format_exc())
    monitor.end_run(success=False)
    raise
```

**That's it!** Now when your scraper runs, it will appear on the dashboard.

---

## 🔍 Special Features

### Automatic HTTP Error Detection
```python
response = requests.get(url)
if response.status_code != 200:
    monitor.log_http_error(url, response.status_code)  # Logs 403, 500, etc.
```

### Track Progress
```python
if processed % 10 == 0:
    monitor.log_info(f"Processed {processed} articles")
```

### Log Warnings
```python
monitor.log_warning("Rate limit approaching", error_code="RATE_LIMIT")
```

---

## 📊 Dashboard Features

### Main View Shows:
- ✅ **Status of each scraper** (running/idle/error/warning)
- 📈 **Total articles scraped** (all time + today)
- ⚠️ **Error count** (last 24 hours)
- 🕐 **Last run times**
- 🔴 **Consecutive errors** (visual alerts!)

### Logs Section Shows:
- 📝 **All log entries** with timestamps
- 🔍 **Filter by scraper** (dropdown)
- 🎯 **Filter by type** (info/warning/error/critical)
- 📋 **Error details** (stack traces, error codes)

### Auto-Refresh:
- Updates every **10 seconds** automatically
- Always shows latest status

---

## 🎨 Visual Indicators

| Color | Status | Meaning |
|-------|--------|---------|
| 🟢 Green | Idle | Last run successful |
| 🔵 Blue | Running | Currently scraping |
| 🟠 Orange | Warning | Has warnings |
| 🔴 Red | Error | Has errors (pulses!) |

---

## 💡 Real-World Example

**Before:**
- Run 8 scrapers at once
- One gets 403 errors
- You don't know which one
- Have to check each scraper manually

**After:**
- Open dashboard: http://localhost:3001
- See **ittefaq** card is RED
- Click to see: "HTTP 403 error"
- Fix just that scraper

---

## 📁 Files You Need to Know

| File | Purpose |
|------|---------|
| `health_monitor.py` | The main class you import |
| `server.js` | Dashboard server (already running) |
| `public/index.html` | Dashboard UI |
| `SETUP_COMPLETE.md` | Full instructions |
| `QUICK_START.md` | Quick reference |
| `example_integration.py` | Code examples |

---

## 🔧 Commands

### Start Dashboard
```bash
cd scraper-health
npm start
```

### Run Test (See Sample Data)
```bash
cd scraper-health
python simple_test.py
```

### View Dashboard
Open: http://localhost:3001

---

## 📝 Integration Checklist

For each scraper you want to monitor:

- [ ] Add import statements at top
- [ ] Create `ScraperHealthMonitor` instance
- [ ] Call `monitor.start_run()` at start
- [ ] Call `monitor.increment_articles()` for each article
- [ ] Call `monitor.end_run(success=True)` on success
- [ ] Catch exceptions and call `monitor.log_critical()` + `monitor.end_run(success=False)`
- [ ] Add `monitor.log_http_error()` for HTTP errors (optional but recommended)

---

## ✨ Benefits

✅ **Instant visibility** - See all scraper statuses at a glance  
✅ **Error detection** - Automatically catches 403, 500, timeouts  
✅ **Central logging** - All logs in one place  
✅ **Performance tracking** - Articles per day, success rates  
✅ **Error analytics** - See which errors occur most  
✅ **Historical data** - Track trends over time  
✅ **Beautiful UI** - Clean, modern dashboard  
✅ **Real-time** - Auto-refreshes every 10 seconds  

---

## 🎓 Learn More

- **Full Docs**: See `README.md` in scraper-health folder
- **Quick Start**: See `QUICK_START.md`
- **Code Example**: See `example_integration.py`
- **Test It**: Run `python simple_test.py`

---

## 🎉 You're Ready!

1. ✅ Dashboard running at http://localhost:3001
2. ✅ Database initialized
3. ✅ Ready to integrate

**Start adding monitoring to your scrapers now!**

---

*Created: Scraper Health Monitoring System v1.0*  
*Dashboard Port: 3001*  
*Auto-refresh: 10 seconds*
