# Scraper Management System

A centralized Node.js-based management system for monitoring and controlling all news scrapers.

## Features

- **Dashboard**: Real-time web interface to monitor all scrapers
- **Process Management**: Start, stop, and restart scrapers from the dashboard
- **Live Monitoring**: Real-time output logs and status updates
- **Statistics**: Track articles processed, errors, uptime, and more
- **Category Tracking**: View last run times for each category
- **REST API**: Programmatic control of scrapers
- **WebSocket Support**: Live updates via Socket.IO

## Installation

```bash
cd scraper-manager
npm install
```

## Usage

### Start the Management System

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The dashboard will be available at: http://localhost:3000

## API Endpoints

### Get All Scrapers Status
```
GET /api/scrapers
```

### Get Single Scraper Status
```
GET /api/scrapers/:id
```

### Start Scraper
```
POST /api/scrapers/:id/start
```

### Stop Scraper
```
POST /api/scrapers/:id/stop
```

### Restart Scraper
```
POST /api/scrapers/:id/restart
```

### Get Scraper Output
```
GET /api/scrapers/:id/output
```

### Start All Scrapers
```
POST /api/scrapers/start-all
```

### Stop All Scrapers
```
POST /api/scrapers/stop-all
```

## Scraper Configuration

Scrapers are configured in `server.js`:

```javascript
const SCRAPERS = {
    'ittefaq': {
        name: 'Ittefaq Scraper',
        path: path.join(__dirname, '..', 'ittefaq-scraper'),
        script: 'scrapittefaq_mysql.py',
        lastRunFile: 'last_processed_date_ittefaq.json'
    },
    // Add more scrapers here
};
```

## Adding New Scrapers

1. Add configuration to `SCRAPERS` object in `server.js`
2. Ensure the scraper directory and script exist
3. Optionally specify a `lastRunFile` to track run times
4. Restart the management system

## WebSocket Events

- `scrapers-status`: Periodic status updates (every 5 seconds)
- `scraper-output`: Real-time output from scrapers
- `scraper-status`: Status change notifications
- `scraper-error`: Error notifications

## File Structure

```
scraper-manager/
├── server.js          # Main server application
├── package.json       # Node.js dependencies
├── README.md         # Documentation
├── logs/             # Log files
│   ├── error.log
│   └── combined.log
└── public/           # Frontend files
    ├── index.html    # Dashboard HTML
    ├── styles.css    # Dashboard styles
    └── app.js        # Dashboard JavaScript
```

## Requirements

- Node.js 14.x or higher
- Python 3.x (for scrapers)
- All scraper dependencies installed

## Features in Detail

### Dashboard
- Overview statistics (total, running, stopped, errors)
- Individual scraper cards with status
- Last run times per category
- Process information (PID, uptime)
- Start/Stop/Restart controls
- View live logs

### Process Management
- Automatic process monitoring
- Graceful shutdown handling
- Error recovery
- Output buffering

### Logging
- Winston-based logging
- Separate error and combined logs
- Console and file outputs

## Troubleshooting

**Scraper won't start:**
- Check if Python script exists
- Verify Python is in PATH
- Check scraper directory path is correct

**Dashboard not updating:**
- Check WebSocket connection
- Refresh the page
- Check server logs

**Port already in use:**
- Change PORT in `server.js`
- Kill process using port 3000

## License

ISC
