const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const winston = require('winston');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const multer = require('multer');

// Auth is now DB-driven — see initAdminTable()

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Session middleware
app.use(session({
    secret: 'scraper-dashboard-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    return res.status(401).json({ error: 'Unauthorized', redirect: '/login.html' });
}

// Protect HTML pages — redirect to login if not authenticated
app.use((req, res, next) => {
    const p = req.path;
    // Always allow login page and all static assets (css/js/images)
    if (p === '/login.html' || p.startsWith('/news_images/')) return next();
    if (p === '/' || p.endsWith('.html')) {
        if (!req.session || !req.session.authenticated) {
            return res.redirect('/login.html');
        }
    }
    next();
});

// ── Auth endpoints (public) ───────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(401).json({ success: false, error: 'Username and password required' });
    }
    try {
        const [rows] = await pool.query(
            'SELECT * FROM dashboard_users WHERE username = ? AND password = ? LIMIT 1',
            [username, password]
        );
        if (rows.length > 0) {
            req.session.authenticated = true;
            req.session.username = username;
            return res.json({ success: true });
        }
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    } catch (err) {
        logger.error('Login DB error:', err);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated), user: req.session.username || null });
});

// ── Protect all other /api/* routes ──────────────────────────────────────────
app.use('/api', (req, res, next) => {
    if (['/login', '/logout', '/auth/status'].includes(req.path)) return next();
    requireAuth(req, res, next);
});

// Serve news images from all scrapers (must be BEFORE express.static('public') to take precedence)
app.use('/news_images', express.static(path.join(__dirname, 'uploaded_news_images')));
// Serve scraped images from centralised folder; each scraper saves to news_images/<name>/
// Express will find ittefaq_abc123.jpg under news_images/ittefaq/ automatically via subdirectory traversal
const newsImagesDir = path.join(__dirname, 'news_images');
fs.readdirSync(newsImagesDir).forEach(sub => {
    const subPath = path.join(newsImagesDir, sub);
    if (fs.statSync(subPath).isDirectory()) {
        app.use('/news_images', express.static(subPath));
    }
});
// Serve public folder (after news_images to avoid path conflicts)
app.use(express.static('public'));

// Database configuration
const dbConfig = {
    host: '103.213.38.238',
    user: 'siamvidb_scraptestg',
    password: 'HuHmf!w=E]%I=3L&',
    database: 'siamvidb_scraptestg',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 20000,      // 20 seconds timeout for initial connection
    acquireTimeout: 20000,      // 20 seconds timeout for acquiring connection from pool
    timeout: 20000,             // 20 seconds timeout for query execution
    enableKeepAlive: true,      // Keep connections alive
    keepAliveInitialDelay: 0    // Start keep-alive immediately
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Test database connection with retry logic
async function testDatabaseConnection(retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            const connection = await pool.getConnection();
            await connection.ping();
            connection.release();
            logger.info('Database connection successful');
            return true;
        } catch (error) {
            logger.warn(`Database connection attempt ${i + 1}/${retries} failed: ${error.message}`);
            if (i < retries - 1) {
                logger.info(`Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    logger.error('Database connection failed after all retries');
    return false;
}

// Global flag to track database availability
let isDatabaseAvailable = false;

// Helper function to execute database queries with error handling
async function executeQuery(query, params = []) {
    if (!isDatabaseAvailable) {
        // Try to reconnect
        isDatabaseAvailable = await testDatabaseConnection(1, 1000);
        if (!isDatabaseAvailable) {
            throw new Error('Database not available');
        }
    }
    
    try {
        return await pool.query(query, params);
    } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.code === 'PROTOCOL_CONNECTION_LOST') {
            isDatabaseAvailable = false;
        }
        throw error;
    }
}

// Logger configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Create logs directory
if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

// Scraper configurations
const SCRAPERS = {
    'ittefaq': {
        name: 'Ittefaq Scraper',
        path: path.join(__dirname, 'scrapers'),
        script: 'ittefaq.js',
        lastRunFile: path.join('..', 'last_run', 'ittefaq.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'jugantor': {
        name: 'Jugantor Scraper',
        logo: 'jugantorlogo',
        path: path.join(__dirname, 'scrapers'),
        script: 'jugantor.js',
        lastRunFile: path.join('..', 'last_run', 'jugantor.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'kalbela': {
        name: 'Kalbela Scraper',
        logo: 'kalbelalogo',
        path: path.join(__dirname, 'scrapers'),
        script: 'kalbela.js',
        lastRunFile: path.join('..', 'last_run', 'kalbela.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'desh': {
        name: 'Desh TV Scraper',
        logo: 'deshtvlogo',
        path: path.join(__dirname, 'scrapers'),
        script: 'desh.js',
        lastRunFile: path.join('..', 'last_run', 'desh.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'bdnews24': {
        name: 'BDNews24 Scraper',
        logo: 'bdnews',
        path: path.join(__dirname, 'scrapers'),
        script: 'bdnews24.js',
        lastRunFile: path.join('..', 'last_run', 'bdnews24.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'prothomalo': {
        name: 'Prothom Alo Scraper',
        logo: 'palo-bangla',
        path: path.join(__dirname, 'scrapers'),
        script: 'prothomalo.js',
        lastRunFile: path.join('..', 'last_run', 'prothomalo.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'dhakapost': {
        name: 'DhakaPost Scraper',
        logo: 'dhakapost',
        path: path.join(__dirname, 'scrapers'),
        script: 'dhakapost.js',
        lastRunFile: path.join('..', 'last_run', 'dhakapost.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'jagonews24': {
        name: 'Jagonews24 Scraper',
        logo: 'jagonews24',
        path: path.join(__dirname, 'scrapers'),
        script: 'jagonews24.js',
        lastRunFile: path.join('..', 'last_run', 'jagonews24.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'samakal': {
        name: 'Samakal Scraper',
        logo: 'samakal',
        path: path.join(__dirname, 'scrapers'),
        script: 'samakal.js',
        lastRunFile: path.join('..', 'last_run', 'samakal.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'sangbad': {
        name: 'Sangbad Scraper',
        logo: 'sangbad',
        path: path.join(__dirname, 'scrapers'),
        script: 'sangbad.js',
        lastRunFile: path.join('..', 'last_run', 'sangbad.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'amadershomoy': {
        name: 'AmaderShomoy Scraper',
        logo: 'amadershomoy',
        path: path.join(__dirname, 'scrapers'),
        script: 'amadershomoy.js',
        lastRunFile: path.join('..', 'last_run', 'amadershomoy.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'bdpratidin': {
        name: 'BD Pratidin Scraper',
        logo: 'bdpratidin',
        path: path.join(__dirname, 'scrapers'),
        script: 'bdpratidin.js',
        lastRunFile: path.join('..', 'last_run', 'bdpratidin.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'mzamin': {
        name: 'Mzamin Scraper',
        logo: 'mzamin',
        path: path.join(__dirname, 'scrapers'),
        script: 'mzamin.js',
        lastRunFile: path.join('..', 'last_run', 'mzamin.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'dhakatribune': {
        name: 'Dhaka Tribune Scraper',
        logo: 'dhakatribune',
        path: path.join(__dirname, 'scrapers'),
        script: 'dhakatribune.js',
        lastRunFile: path.join('..', 'last_run', 'dhakatribune.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'janakantha': {
        name: 'Janakantha Scraper',
        logo: 'janakantha',
        path: path.join(__dirname, 'scrapers'),
        script: 'janakantha.js',
        lastRunFile: path.join('..', 'last_run', 'janakantha.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    },
    'boishakhi': {
        name: 'Boishakhi Scraper',
        logo: 'boishakhi',
        path: path.join(__dirname, 'scrapers'),
        script: 'boishakhi.js',
        lastRunFile: path.join('..', 'last_run', 'boishakhi.json'),
        status: 'stopped',
        process: null,
        lastRun: null,
        categories: {},
        stats: {
            articlesProcessed: 0,
            errors: 0,
            startTime: null,
            uptime: 0
        },
        currentStatus: {
            state: 'idle',
            details: ''
        },
        output: []
    }
};

// Load last run times for all scrapers
function loadLastRunTimes() {
    Object.keys(SCRAPERS).forEach(scraperId => {
        const scraper = SCRAPERS[scraperId];
        if (scraper.lastRunFile) {
            const filePath = path.join(scraper.path, scraper.lastRunFile);
            try {
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    scraper.categories = data;
                    scraper.lastRun = getLatestTimestamp(data);
                }
            } catch (error) {
                logger.error(`Error loading last run times for ${scraperId}: ${error.message}`);
            }
        }
    });
}

// Get latest timestamp from categories
function getLatestTimestamp(categories) {
    const timestamps = Object.values(categories);
    if (timestamps.length === 0) return null;
    return timestamps.sort().reverse()[0];
}

// Start a scraper
function startScraper(scraperId) {
    const scraper = SCRAPERS[scraperId];
    
    if (!scraper) {
        return { success: false, message: 'Scraper not found' };
    }
    
    if (scraper.status === 'running') {
        return { success: false, message: 'Scraper already running' };
    }
    
    // Check if Python script exists
    const scriptPath = path.join(scraper.path, scraper.script);
    if (!fs.existsSync(scriptPath)) {
        return { success: false, message: `Script not found: ${scriptPath}` };
    }
    
    try {
        // Start the Python process with unbuffered output (-u flag)
        // This ensures real-time output when Python is run through Node.js
        
        // Set UTF-8 encoding for Python to handle Bengali and special characters
        const pythonEnv = { ...process.env };
        pythonEnv.PYTHONIOENCODING = 'utf-8';
        pythonEnv.PYTHONUTF8 = '1';

        // Use venv Python to ensure all packages are available (cross-platform)
        const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
        const venvPythonLinux = path.join(__dirname, '.venv', 'bin', 'python3');
        const pythonCmd = fs.existsSync(venvPython) ? venvPython
                        : fs.existsSync(venvPythonLinux) ? venvPythonLinux
                        : 'python3';

        // For Node.js scrapers (.js), run with node directly
        const isNodeScript = scraper.script.endsWith('.js');
        const cmd  = isNodeScript ? 'node' : pythonCmd;
        const args = isNodeScript ? [scraper.script] : ['-u', scraper.script];

        const pythonProcess = spawn(cmd, args, {
            cwd: scraper.path,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: pythonEnv  // Use UTF-8 environment
        });
        
        scraper.process = pythonProcess;
        scraper.status = 'running';
        scraper.stats.startTime = new Date().toISOString();
        scraper.stats.articlesProcessed = 0;
        scraper.stats.errors = 0;
        scraper.output = [];
        
        logger.info(`Started ${scraper.name} (PID: ${pythonProcess.pid})`);
        
        // Test emission: Send initial status after 2 seconds
        scraper.statusTimeout = setTimeout(() => {
            // Only emit if still running
            if (scraper.status === 'running') {
                const testStatus = { state: 'finding', details: 'Initializing...' };
                scraper.currentStatus = testStatus;
                io.emit('scraper-status-update', {
                    scraperId,
                    currentStatus: testStatus
                });
                logger.info(`Test status emitted for ${scraperId}: ${JSON.stringify(testStatus)}`);
            }
        }, 2000);
        
        // Handle stdout
        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            
            // Parse for status updates [STATUS:state:details]
            const statusMatch = output.match(/\[STATUS:(finding|extracting|waiting):(.+?)\]/);
            if (statusMatch) {
                const state = statusMatch[1];
                const details = statusMatch[2];
                scraper.currentStatus = { state, details };

                // Emit status update
                io.emit('scraper-status-update', {
                    scraperId,
                    currentStatus: scraper.currentStatus
                });

                // Don't log status messages to console (too verbose)
                // They are already being sent to the dashboard
            } else {
                // Log to console for debugging (only non-status messages)
                console.log(`[${scraperId}] ${output.trim()}`);
            }
            
            scraper.output.push({
                type: 'stdout',
                message: output,
                timestamp: new Date().toISOString()
            });
            
            // Keep only last 100 lines
            if (scraper.output.length > 100) {
                scraper.output.shift();
            }
            
            // Parse for article count - look for "Inserted new article" or "Updated existing article"
            if (
                output.includes('✓ Inserted new article') ||
                output.includes('✓ Updated existing article') ||
                output.includes('Inserted new article id') ||
                output.includes('Updating existing article') ||
                output.includes('[OK] Inserted new article') ||
                output.includes('[OK] Updated existing article') ||
                output.includes('Inserted new article (id') ||
                output.includes('Updated existing article (id') ||
                output.includes('[OK] Inserted new article (ID:')  // Added for samakal
            ) {
                scraper.stats.articlesProcessed++;
                io.emit('scraper-stats', {
                    scraperId,
                    stats: scraper.stats
                });
            }
            
            // Parse for success indicators
            if (output.includes('✓ Successfully processed') || output.includes('✓ SUCCESS')) {
                scraper.stats.articlesProcessed++;
                io.emit('scraper-stats', {
                    scraperId,
                    stats: scraper.stats
                });
            }
            
            // Parse for errors
            if (output.toLowerCase().includes('error') || output.includes('Failed to scrape') || output.includes('✗')) {
                scraper.stats.errors++;
                io.emit('scraper-stats', {
                    scraperId,
                    stats: scraper.stats
                });
            }
            
            // Emit to connected clients
            io.emit('scraper-output', {
                scraperId,
                output: output,
                type: 'stdout'
            });
        });
        
        // Handle stderr
        pythonProcess.stderr.on('data', (data) => {
            const output = data.toString();
            
            // Log to console for debugging
            console.error(`[${scraperId}] ERROR: ${output.trim()}`);
            
            scraper.output.push({
                type: 'stderr',
                message: output,
                timestamp: new Date().toISOString()
            });
            
            if (scraper.output.length > 100) {
                scraper.output.shift();
            }
            
            if (output.toLowerCase().includes('error')) {
                scraper.stats.errors++;
            }

            io.emit('scraper-output', {
                scraperId,
                output: output,
                type: 'stderr'
            });
        });
        
        // Handle process exit
        pythonProcess.on('close', (code) => {
            scraper.status = 'stopped';
            scraper.process = null;
            
            const message = `${scraper.name} stopped with code ${code}`;
            logger.info(message);
            
            io.emit('scraper-status', {
                scraperId,
                status: 'stopped',
                code
            });
            
            // Reload last run times
            loadLastRunTimes();
        });
        
        pythonProcess.on('error', (error) => {
            scraper.status = 'error';
            scraper.stats.errors++;
            logger.error(`Error with ${scraper.name}: ${error.message}`);
            
            io.emit('scraper-error', {
                scraperId,
                error: error.message
            });
        });
        
        // Emit status update
        io.emit('scraper-status', {
            scraperId,
            status: 'running',
            pid: pythonProcess.pid
        });
        
        return { success: true, message: 'Scraper started', pid: pythonProcess.pid };
        
    } catch (error) {
        logger.error(`Failed to start ${scraper.name}: ${error.message}`);
        scraper.status = 'error';
        return { success: false, message: error.message };
    }
}

// Stop a scraper
function stopScraper(scraperId) {
    const scraper = SCRAPERS[scraperId];
    
    if (!scraper) {
        return { success: false, message: 'Scraper not found' };
    }
    
    if (scraper.status !== 'running' || !scraper.process) {
        return { success: false, message: 'Scraper not running' };
    }
    
    try {
        // Clear any pending status timeouts
        if (scraper.statusTimeout) {
            clearTimeout(scraper.statusTimeout);
            scraper.statusTimeout = null;
        }
        
        // Force kill immediately instead of graceful shutdown
        scraper.process.kill('SIGKILL');
        
        // Update status immediately
        scraper.status = 'stopped';
        scraper.process = null;
        scraper.pid = null;
        scraper.currentStatus = { state: 'idle', details: '' };
        
        // Emit status change immediately
        io.emit('scraper-status', {
            scraperId,
            status: 'stopped'
        });
        
        logger.info(`Stopped ${scraper.name} (forced)`);
        
        return { success: true, message: 'Scraper stopped' };
        
    } catch (error) {
        logger.error(`Failed to stop ${scraper.name}: ${error.message}`);
        return { success: false, message: error.message };
    }
}

// Restart a scraper
function restartScraper(scraperId) {
    const stopResult = stopScraper(scraperId);
    if (!stopResult.success && SCRAPERS[scraperId].status === 'running') {
        return stopResult;
    }
    
    // Wait a bit before restarting
    setTimeout(() => {
        startScraper(scraperId);
    }, 2000);
    
    return { success: true, message: 'Scraper restarting...' };
}

// Get scraper status
function getScraperStatus(scraperId) {
    const scraper = SCRAPERS[scraperId];
    if (!scraper) return null;
    
    // Calculate uptime
    if (scraper.status === 'running' && scraper.stats.startTime) {
        const startTime = new Date(scraper.stats.startTime);
        scraper.stats.uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    }
    
    return {
        name: scraper.name,
        logo: scraper.logo,
        status: scraper.status,
        lastRun: scraper.lastRun,
        categories: scraper.categories,
        stats: scraper.stats,
        currentStatus: scraper.currentStatus,
        pid: scraper.process ? scraper.process.pid : null
    };
}

// Get all scrapers status
function getAllScrapersStatus() {
    const status = {};
    Object.keys(SCRAPERS).forEach(scraperId => {
        status[scraperId] = getScraperStatus(scraperId);
    });
    return status;
}

// REST API Endpoints
app.get('/api/scrapers', async (req, res) => {
    const status = getAllScrapersStatus();
    try {
        if (isDatabaseAvailable) {
            const [rows] = await pool.query('SELECT site, autorun FROM scraper_autorun');
            rows.forEach(row => {
                if (status[row.site]) status[row.site].autorun = row.autorun;
            });
        }
    } catch (e) { /* non-critical, ignore */ }
    // Default autorun to 1 for scrapers not yet in table
    Object.keys(status).forEach(id => {
        if (status[id].autorun === undefined) status[id].autorun = 1;
    });
    res.json(status);
});

app.get('/api/scrapers/:id', async (req, res) => {
    const status = getScraperStatus(req.params.id);
    if (!status) {
        return res.status(404).json({ error: 'Scraper not found' });
    }

    // Fetch category status from database
    try {
        if (!isDatabaseAvailable) {
            logger.warn('Database not available, returning scraper status without category info');
            status.categoryStatus = {};
            status.databaseAvailable = false;
            return res.json(status);
        }

        const [rows] = await executeQuery(
            'SELECT section_label, is_active FROM categories WHERE site = ? ORDER BY section_label',
            [req.params.id]
        );

        // Create a map of category status
        const categoryStatus = {};
        rows.forEach(row => {
            categoryStatus[row.section_label] = row.is_active === 1;
        });

        // Add category status to the response
        status.categoryStatus = categoryStatus;
        status.databaseAvailable = true;
    } catch (err) {
        logger.error('Error fetching category status:', err);
        status.categoryStatus = {};
        status.databaseAvailable = false;
    }

    res.json(status);
});

app.post('/api/scrapers/:id/start', (req, res) => {
    const result = startScraper(req.params.id);
    res.json(result);
});

app.post('/api/scrapers/:id/stop', (req, res) => {
    const result = stopScraper(req.params.id);
    res.json(result);
});

app.post('/api/scrapers/:id/restart', (req, res) => {
    const result = restartScraper(req.params.id);
    res.json(result);
});

// Update category datetime for a scraper
app.put('/api/scrapers/:id/category', async (req, res) => {
    const { id } = req.params;
    const { category, datetime } = req.body;
    
    const scraper = SCRAPERS[id];
    if (!scraper) {
        return res.status(404).json({ error: 'Scraper not found' });
    }
    
    // Prevent updates while scraper is running
    if (scraper.status === 'running') {
        return res.status(400).json({ error: 'Cannot update categories while scraper is running. Please stop the scraper first.' });
    }
    
    if (!category || !datetime) {
        return res.status(400).json({ error: 'Category and datetime are required' });
    }
    
    try {
        // Read the last_processed_date file
        const lastProcessedFile = scraper.lastRunFile;
        if (!lastProcessedFile) {
            return res.status(400).json({ error: 'Scraper does not have a last processed file configured' });
        }
        
        const filePath = path.join(scraper.path, lastProcessedFile);
        
        // Read existing data
        let data = {};
        if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf8');
            data = JSON.parse(content);
        }
        
        // Update the category
        data[category] = datetime;
        
        // Write back to file
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 4), 'utf8');
        
        // Update in-memory categories
        scraper.categories[category] = datetime;
        
        // Emit update to all connected clients
        io.emit('scraper-stats', {
            scraperId: id,
            stats: scraper.stats
        });
        
        logger.info(`Updated ${category} to ${datetime} for ${id}`);
        res.json({ success: true, category, datetime });
        
    } catch (error) {
        logger.error(`Error updating category for ${id}:`, error);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

app.get('/api/scrapers/:id/output', (req, res) => {
    const scraper = SCRAPERS[req.params.id];
    if (!scraper) {
        return res.status(404).json({ error: 'Scraper not found' });
    }
    res.json({ output: scraper.output });
});

app.post('/api/scrapers/start-all', (req, res) => {
    const results = {};
    Object.keys(SCRAPERS).forEach(scraperId => {
        results[scraperId] = startScraper(scraperId);
    });
    res.json(results);
});

app.post('/api/scrapers/stop-all', (req, res) => {
    const results = {};
    Object.keys(SCRAPERS).forEach(scraperId => {
        results[scraperId] = stopScraper(scraperId);
    });
    res.json(results);
});

// Endpoint to trigger recheck of all articles
app.post('/api/recheck-articles', async (req, res) => {
    try {
        const venvPy = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
        const venvPyLinux = path.join(__dirname, '.venv', 'bin', 'python3');
        const recheckPython = fs.existsSync(venvPy) ? venvPy
                            : fs.existsSync(venvPyLinux) ? venvPyLinux
                            : 'python3';
        const recheckProcess = spawn(recheckPython, ['-u', 'rechecker.py'], {
            cwd: __dirname
        });

        recheckProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                logger.info(`Recheck stdout: ${line}`);
                const match = line.match(/^PROGRESS (\d+) (\d+)/);
                if (match) {
                    const current = parseInt(match[1], 10);
                    const total = parseInt(match[2], 10);
                    io.emit('recheck-progress', { current, total });
                }
            });
        });

        recheckProcess.stderr.on('data', (data) => {
            logger.error(`Recheck stderr: ${data}`);
        });

        recheckProcess.on('close', (code) => {
            logger.info(`Recheck process exited with code ${code}`);
            io.emit('recheck-finished', { code });
        });

        res.json({ success: true, message: 'Recheck process started' });
    } catch (error) {
        logger.error(`Error starting recheck process: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to start recheck process' });
    }
});

// Scheduled recheck jobs
const scheduledRecheckJobs = [];
let currentScheduleConfig = null; // Store current schedule configuration

// Get current schedule configuration
app.get('/api/schedule-recheck', (req, res) => {
    res.json({ success: true, config: currentScheduleConfig });
});

app.post('/api/schedule-recheck', (req, res) => {
    const { type, time } = req.body;
    // Remove all previous jobs
    scheduledRecheckJobs.forEach(job => job.stop());
    scheduledRecheckJobs.length = 0;
    let cronTime;
    if (type === 'daily') {
        // time: "HH:MM"
        const [hour, minute] = time.split(':');
        cronTime = `${minute} ${hour} * * *`;
    } else if (type === 'weekly') {
        // time: "HH:MM" (every Sunday)
        const [hour, minute] = time.split(':');
        cronTime = `${minute} ${hour} * * 0`;
    } else {
        return res.json({ success: false, message: 'Invalid schedule type' });
    }
    const job = cron.schedule(cronTime, () => {
        const venvPy = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
        const venvPyLinux = path.join(__dirname, '.venv', 'bin', 'python3');
        const recheckPython = fs.existsSync(venvPy) ? venvPy
                            : fs.existsSync(venvPyLinux) ? venvPyLinux
                            : 'python3';
        const recheckProcess = spawn(recheckPython, ['-u', 'rechecker.py'], {
            cwd: __dirname
        });
        recheckProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                logger.info(`Scheduled Recheck stdout: ${line}`);
                const match = line.match(/^PROGRESS (\d+) (\d+)/);
                if (match) {
                    const current = parseInt(match[1], 10);
                    const total = parseInt(match[2], 10);
                    io.emit('recheck-progress', { current, total });
                }
            });
        });
        recheckProcess.stderr.on('data', (data) => {
            logger.error(`Scheduled Recheck stderr: ${data}`);
        });
        recheckProcess.on('close', (code) => {
            logger.info(`Scheduled Recheck process exited with code ${code}`);
            io.emit('recheck-finished', { code });
        });
    });
    scheduledRecheckJobs.push(job);
    // Save the schedule configuration
    currentScheduleConfig = { type, time };
    logger.info(`Schedule set: ${type} at ${time}`);
    res.json({ success: true });
});

// Reset scheduled recheck
app.post('/api/reset-schedule-recheck', (req, res) => {
    try {
        // Stop all scheduled jobs
        scheduledRecheckJobs.forEach(job => job.stop());
        scheduledRecheckJobs.length = 0;
        // Clear the schedule configuration
        currentScheduleConfig = null;
        logger.info('All scheduled recheck jobs have been reset');
        res.json({ success: true, message: 'Scheduler reset successfully' });
    } catch (error) {
        logger.error(`Error resetting scheduler: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to reset scheduler' });
    }
});

// ============ Articles API Endpoints ============

// Get articles statistics (must come before /:id route)
app.get('/api/articles/stats', async (req, res) => {
    try {
        // Total articles
        const [totalResult] = await pool.query('SELECT COUNT(*) as count FROM articles');
        const total = totalResult[0].count;
        
        // Today's articles
        const [todayResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE DATE(published_at) = CURDATE()'
        );
        const today = todayResult[0].count;
        
        // By source
        const [ittefaqResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%ittefaq%']
        );
        const ittefaq = ittefaqResult[0].count;
        
        const [jugantorResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%jugantor%']
        );
        const jugantor = jugantorResult[0].count;
        
        const [kalbelaResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%kalbela%']
        );
        const kalbela = kalbelaResult[0].count;
        
        const [deshResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%desh%']
        );
        const desh = deshResult[0].count;

        const [dhakapostResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%dhakapost%']
        );
        const dhakapost = dhakapostResult[0].count;

        const [jagonews24Result] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%jagonews24%']
        );
        const jagonews24 = jagonews24Result[0].count;

        const [bdnews24Result] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%bdnews24%']
        );
        const bdnews24 = bdnews24Result[0].count;

        const [prothomaloResult] = await pool.query(
            'SELECT COUNT(*) as count FROM articles WHERE source_site LIKE ?',
            ['%prothomalo%']
        );
        const prothomalo = prothomaloResult[0].count;

        res.json({
            total,
            today,
            ittefaq,
            jugantor,
            kalbela,
            desh,
            dhakapost,
            jagonews24,
            bdnews24,
            prothomalo
        });
    } catch (error) {
        logger.error('Error fetching article stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Report endpoint: article counts by source/date range
app.get('/api/report', async (req, res) => {
    try {
        let date_from, date_to;
        const preset = req.query.preset;
        const source = req.query.source;

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        if (preset === 'today') {
            date_from = date_to = todayStr;
        } else if (preset === 'yesterday') {
            const y = new Date(today); y.setDate(y.getDate() - 1);
            date_from = date_to = y.toISOString().split('T')[0];
        } else if (preset === 'week') {
            const w = new Date(today); w.setDate(w.getDate() - 6);
            date_from = w.toISOString().split('T')[0]; date_to = todayStr;
        } else if (preset === 'month') {
            const m = new Date(today); m.setDate(m.getDate() - 29);
            date_from = m.toISOString().split('T')[0]; date_to = todayStr;
        } else {
            date_from = req.query.date_from || todayStr;
            date_to   = req.query.date_to   || todayStr;
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        }

        const sourceCondition = source ? 'AND source_site LIKE ?' : '';
        const sourceParams    = source ? [`%${source}%`] : [];

        const [bySource] = await pool.query(
            `SELECT source_site, COUNT(*) as count
             FROM articles
             WHERE DATE(published_at) BETWEEN ? AND ?
             ${sourceCondition}
             GROUP BY source_site
             ORDER BY count DESC`,
            [date_from, date_to, ...sourceParams]
        );

        const [byDate] = await pool.query(
            `SELECT DATE(published_at) as date, COUNT(*) as count
             FROM articles
             WHERE DATE(published_at) BETWEEN ? AND ?
             ${sourceCondition}
             GROUP BY DATE(published_at)
             ORDER BY date ASC`,
            [date_from, date_to, ...sourceParams]
        );

        const [bySourceCategory] = await pool.query(
            `SELECT source_site,
                    CASE
                        WHEN TRIM(category) REGEXP '^[0-9]+$' THEN COALESCE(NULLIF(TRIM(section),''), TRIM(category), 'Uncategorized')
                        WHEN TRIM(category) = '' OR category IS NULL THEN COALESCE(NULLIF(TRIM(section),''), 'Uncategorized')
                        ELSE TRIM(category)
                    END as category,
                    COUNT(*) as count
             FROM articles
             WHERE DATE(published_at) BETWEEN ? AND ?
             ${sourceCondition}
             GROUP BY source_site, section, category
             ORDER BY source_site, count DESC`,
            [date_from, date_to, ...sourceParams]
        );

        const total = bySource.reduce((sum, r) => sum + Number(r.count), 0);

        res.json({
            date_from,
            date_to,
            total,
            by_source: bySource.map(r => ({
                source: r.source_site,
                count: Number(r.count),
                percentage: total > 0 ? Math.round((Number(r.count) / total) * 1000) / 10 : 0
            })),
            by_source_category: bySourceCategory.map(r => ({
                source: r.source_site,
                category: r.category,
                count: Number(r.count)
            })),
            by_date: byDate.map(r => ({
                date: (r.date instanceof Date ? r.date.toISOString() : String(r.date)).split('T')[0],
                count: Number(r.count)
            }))
        });
    } catch (error) {
        logger.error('Error fetching report:', error);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

// Get articles with pagination and filters
app.get('/api/articles', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        
        let whereConditions = [];
        let queryParams = [];
        
        // Source filter
        if (req.query.source) {
            whereConditions.push('source_site LIKE ?');
            queryParams.push(`%${req.query.source}%`);
        }
        
        // Date filter
        if (req.query.date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            let dateCondition = '';
            switch (req.query.date) {
                case 'today':
                    dateCondition = 'DATE(published_at) = CURDATE()';
                    break;
                case 'yesterday':
                    dateCondition = 'DATE(published_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
                    break;
                case 'week':
                    dateCondition = 'published_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
                    break;
                case 'month':
                    dateCondition = 'published_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
                    break;
            }
            if (dateCondition) {
                whereConditions.push(dateCondition);
            }
        }
        
        // Category filter
        if (req.query.category) {
            whereConditions.push('category = ?');
            queryParams.push(req.query.category);
        }
        
        // Search filter
        if (req.query.search) {
            whereConditions.push('(headline LIKE ? OR content LIKE ?)');
            queryParams.push(`%${req.query.search}%`, `%${req.query.search}%`);
        }
        
        const whereClause = whereConditions.length > 0 
            ? 'WHERE ' + whereConditions.join(' AND ') 
            : '';
        
        // Get total count
        const [countResult] = await pool.query(
            `SELECT COUNT(*) as total FROM articles ${whereClause}`,
            queryParams
        );
        const total = countResult[0].total;
        
        // Get articles
        const [articles] = await pool.query(
            `SELECT id, headline, image_name, source_site, source_url, 
                    category, published_at, tags
             FROM articles 
             ${whereClause}
             ORDER BY published_at DESC
             LIMIT ? OFFSET ?`,
            [...queryParams, limit, offset]
        );
        
        res.json({
            articles,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        logger.error('Error fetching articles:', error);
        res.status(500).json({ error: 'Failed to fetch articles' });
    }
});

// Get single article by ID
app.get('/api/articles/:id', async (req, res) => {
    try {
        const [articles] = await pool.query(
            'SELECT * FROM articles WHERE id = ?',
            [req.params.id]
        );
        
        if (articles.length === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }
        
        res.json(articles[0]);
    } catch (error) {
        logger.error('Error fetching article:', error);
        res.status(500).json({ error: 'Failed to fetch article' });
    }
});

// Multer setup for article image uploads
const articleImageDir = path.join(__dirname, 'uploaded_news_images');
if (!fs.existsSync(articleImageDir)) fs.mkdirSync(articleImageDir, { recursive: true });
const articleImageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, articleImageDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = `article_${req.params.id}_${Date.now()}${ext}`;
        cb(null, name);
    }
});
const articleImageUpload = multer({ storage: articleImageStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Upload article image
app.post('/api/articles/:id/image', articleImageUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
        const imageName = req.file.filename;
        await pool.query('UPDATE articles SET image_name = ? WHERE id = ?', [imageName, req.params.id]);
        logger.info(`Article ${req.params.id} image updated to ${imageName}`);
        res.json({ success: true, image_name: imageName });
    } catch (error) {
        logger.error('Error uploading article image:', error);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// Update article by ID
app.put('/api/articles/:id', async (req, res) => {
    try {
        const { headline, content, tags } = req.body;
        const fields = [];
        const values = [];
        if (headline !== undefined) { fields.push('headline = ?'); values.push(headline); }
        if (content !== undefined) { fields.push('content = ?'); values.push(content); }
        if (tags !== undefined) { fields.push('tags = ?'); values.push(tags); }
        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
        values.push(req.params.id);
        const [result] = await pool.query(`UPDATE articles SET ${fields.join(', ')} WHERE id = ?`, values);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Article not found' });
        logger.info(`Article ${req.params.id} updated`);
        res.json({ success: true, message: 'Article updated successfully' });
    } catch (error) {
        logger.error('Error updating article:', error);
        res.status(500).json({ error: 'Failed to update article' });
    }
});

// Bulk delete articles by IDs
app.delete('/api/articles/bulk', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No article IDs provided' });
        }
        const placeholders = ids.map(() => '?').join(',');
        const [result] = await pool.query(`DELETE FROM articles WHERE id IN (${placeholders})`, ids);
        logger.info(`Bulk deleted ${result.affectedRows} articles`);
        res.json({ success: true, deletedCount: result.affectedRows });
    } catch (error) {
        logger.error('Error bulk deleting articles:', error);
        res.status(500).json({ error: 'Failed to bulk delete articles' });
    }
});

// Delete article by ID
app.delete('/api/articles/:id', async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM articles WHERE id = ?',
            [req.params.id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }
        
        logger.info(`Article ${req.params.id} deleted`);
        res.json({ success: true, message: 'Article deleted successfully' });
    } catch (error) {
        logger.error('Error deleting article:', error);
        res.status(500).json({ error: 'Failed to delete article' });
    }
});

// Delete all articles
app.delete('/api/articles', async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM articles');
        
        logger.info(`All articles deleted (${result.affectedRows} rows)`);
        res.json({ 
            success: true, 
            message: 'All articles deleted successfully',
            deletedCount: result.affectedRows
        });
    } catch (error) {
        logger.error('Error deleting all articles:', error);
        res.status(500).json({ error: 'Failed to delete all articles' });
    }
});

// ============ Category Management API Endpoints ============

// Get all categories
app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM categories ORDER BY site, section_label'
        );
        res.json(rows);
    } catch (error) {
        logger.error('Error fetching categories:', error);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// Get categories by site
app.get('/api/categories/:site', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM categories WHERE site = ? ORDER BY section_label',
            [req.params.site]
        );
        res.json(rows);
    } catch (error) {
        logger.error('Error fetching categories:', error);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// Add a new category
app.post('/api/categories', async (req, res) => {
    try {
        const { category_url, section_label, site, is_active } = req.body;

        // Validate required fields
        if (!category_url || !section_label || !site) {
            return res.status(400).json({ error: 'category_url, section_label, and site are required' });
        }

        // Check for duplicate (same site + category_url)
        const [existing] = await pool.query(
            'SELECT id FROM categories WHERE site = ? AND category_url = ?',
            [site, category_url]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Category already exists', details: `${site} already has a category with that URL` });
        }

        const activeVal = (is_active === undefined || is_active === null) ? 1 : (is_active ? 1 : 0);

        const [result] = await pool.query(
            'INSERT INTO categories (site, category_url, section_label, is_active) VALUES (?, ?, ?, ?)',
            [site, category_url, section_label, activeVal]
        );

        logger.info(`Category added: [${site}] ${section_label} -> ${category_url}`);
        res.status(201).json({
            success: true,
            id: result.insertId,
            site,
            category_url,
            section_label,
            is_active: activeVal
        });
    } catch (error) {
        logger.error('Error adding category:', error);
        res.status(500).json({ error: 'Failed to add category', details: error.message });
    }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
    try {
        const [stats] = await pool.query(`
            SELECT 
                site,
                COUNT(*) as total,
                SUM(is_active) as active,
                SUM(1 - is_active) as disabled
            FROM categories
            GROUP BY site
        `);
        
        const [totalStats] = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(is_active) as active,
                SUM(1 - is_active) as disabled
            FROM categories
        `);
        
        res.json({
            bySite: stats,
            overall: totalStats[0]
        });
    } catch (error) {
        logger.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Toggle category status
app.patch('/api/categories/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get current status
        const [current] = await pool.query(
            'SELECT is_active FROM categories WHERE id = ?',
            [id]
        );
        
        if (current.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        
        const newStatus = current[0].is_active ? 0 : 1;
        
        // Update status
        await pool.query(
            'UPDATE categories SET is_active = ? WHERE id = ?',
            [newStatus, id]
        );
        
        res.json({ success: true, is_active: newStatus });
    } catch (error) {
        logger.error('Error toggling category:', error);
        res.status(500).json({ error: 'Failed to toggle category' });
    }
});

// Bulk enable/disable
app.patch('/api/categories/bulk/:action', async (req, res) => {
    try {
        const { action } = req.params;
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Invalid IDs provided' });
        }
        
        const newStatus = action === 'enable' ? 1 : 0;
        
        const placeholders = ids.map(() => '?').join(',');
        await pool.query(
            `UPDATE categories SET is_active = ? WHERE id IN (${placeholders})`,
            [newStatus, ...ids]
        );
        
        res.json({ success: true, updated: ids.length });
    } catch (error) {
        logger.error('Error bulk updating:', error);
        res.status(500).json({ error: 'Failed to update categories' });
    }
});

// ============ Autorun API Endpoints ============

app.get('/api/autorun/:site', async (req, res) => {
    try {
        if (!isDatabaseAvailable) return res.json({ site: req.params.site, autorun: 1 });
        const [rows] = await pool.query('SELECT autorun FROM scraper_autorun WHERE site = ?', [req.params.site]);
        const autorun = rows.length > 0 ? rows[0].autorun : 1;
        res.json({ site: req.params.site, autorun });
    } catch (error) {
        logger.error('Error fetching autorun:', error);
        res.json({ site: req.params.site, autorun: 1 });
    }
});

app.post('/api/autorun/:site', async (req, res) => {
    try {
        const { autorun } = req.body;
        if (autorun !== 0 && autorun !== 1) {
            return res.status(400).json({ error: 'autorun must be 0 or 1' });
        }
        await pool.query(
            'INSERT INTO scraper_autorun (site, autorun) VALUES (?, ?) ON DUPLICATE KEY UPDATE autorun = ?',
            [req.params.site, autorun, autorun]
        );
        res.json({ success: true, site: req.params.site, autorun });
    } catch (error) {
        logger.error('Error setting autorun:', error);
        res.status(500).json({ error: 'Failed to update autorun' });
    }
});

// Search categories
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        
        const [rows] = await pool.query(
            `SELECT * FROM categories 
             WHERE section_label LIKE ? OR category_url LIKE ?
             ORDER BY site, section_label`,
            [`%${q}%`, `%${q}%`]
        );
        
        res.json(rows);
    } catch (error) {
        logger.error('Error searching:', error);
        res.status(500).json({ error: 'Failed to search categories' });
    }
});

// ============ Keyword Monitor API Endpoints ============

// Keyword monitoring state
let keywordMonitoringEnabled = false;
let lastCheckedArticleId = 0;

// Initialize keywords tables
async function initKeywordTables() {
    if (!isDatabaseAvailable) {
        logger.warn('Skipping keyword tables initialization - database not available');
        return false;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS keywords (
                id INT AUTO_INCREMENT PRIMARY KEY,
                keyword VARCHAR(255) NOT NULL UNIQUE,
                is_active TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS keyword_matches (
                id INT AUTO_INCREMENT PRIMARY KEY,
                keyword_id INT NOT NULL,
                article_id INT NOT NULL,
                matched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_read TINYINT(1) DEFAULT 0,
                UNIQUE KEY unique_match (keyword_id, article_id)
            )
        `);

        // Check if keyword_settings table exists and has the right columns
        const [tables] = await pool.query("SHOW TABLES LIKE 'keyword_settings'");
        if (tables.length === 0) {
            // Create fresh table
            await pool.query(`
                CREATE TABLE keyword_settings (
                    id INT PRIMARY KEY DEFAULT 1,
                    enabled TINYINT(1) DEFAULT 0,
                    last_checked_id INT DEFAULT 0
                )
            `);
            await pool.query(`INSERT INTO keyword_settings (id, enabled, last_checked_id) VALUES (1, 0, 0)`);
        } else {
            // Table exists - check columns and add if missing
            const [columns] = await pool.query("SHOW COLUMNS FROM keyword_settings");
            const columnNames = columns.map(c => c.Field);

            if (!columnNames.includes('enabled')) {
                await pool.query("ALTER TABLE keyword_settings ADD COLUMN enabled TINYINT(1) DEFAULT 0");
            }
            if (!columnNames.includes('last_checked_id')) {
                await pool.query("ALTER TABLE keyword_settings ADD COLUMN last_checked_id INT DEFAULT 0");
            }

            // Ensure at least one row exists
            const [rows] = await pool.query('SELECT * FROM keyword_settings WHERE id = 1');
            if (rows.length === 0) {
                await pool.query(`INSERT INTO keyword_settings (id, enabled, last_checked_id) VALUES (1, 0, 0)`);
            }
        }

        // Load settings
        const [settings] = await pool.query('SELECT * FROM keyword_settings WHERE id = 1');
        if (settings.length > 0) {
            keywordMonitoringEnabled = settings[0].enabled === 1;
            lastCheckedArticleId = settings[0].last_checked_id || 0;
        }
        logger.info('Keyword tables initialized successfully');
        return true;
    } catch (error) {
        logger.error('Error initializing keyword tables:', error);
        isDatabaseAvailable = false;
        return false;
    }
}

// Get all keywords with status
app.get('/api/keywords', async (req, res) => {
    try {
        const [keywords] = await pool.query('SELECT * FROM keywords ORDER BY created_at DESC');
        const [settings] = await pool.query('SELECT * FROM keyword_settings WHERE id = 1');
        const [maxId] = await pool.query('SELECT MAX(id) as maxId FROM articles');

        res.json({
            keywords,
            enabled: settings[0]?.enabled === 1,
            lastCheckedId: settings[0]?.last_checked_id || 0,
            maxArticleId: maxId[0]?.maxId || 0,
            pendingArticles: Math.max(0, (maxId[0]?.maxId || 0) - (settings[0]?.last_checked_id || 0))
        });
    } catch (error) {
        logger.error('Error fetching keywords:', error);
        res.status(500).json({ error: 'Failed to fetch keywords' });
    }
});

// Add keyword
app.post('/api/keywords', async (req, res) => {
    try {
        const { keyword } = req.body;
        if (!keyword || !keyword.trim()) {
            return res.status(400).json({ error: 'Keyword is required' });
        }

        const [result] = await pool.query(
            'INSERT INTO keywords (keyword) VALUES (?)',
            [keyword.trim()]
        );

        // Emit update to all clients
        const [keywords] = await pool.query('SELECT * FROM keywords ORDER BY created_at DESC');
        io.emit('keywords-updated', { keywords, enabled: keywordMonitoringEnabled });

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Keyword already exists' });
        }
        logger.error('Error adding keyword:', error);
        res.status(500).json({ error: 'Failed to add keyword' });
    }
});

// Delete keyword
app.delete('/api/keywords/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM keywords WHERE id = ?', [req.params.id]);

        // Emit update to all clients
        const [keywords] = await pool.query('SELECT * FROM keywords ORDER BY created_at DESC');
        io.emit('keywords-updated', { keywords, enabled: keywordMonitoringEnabled });

        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting keyword:', error);
        res.status(500).json({ error: 'Failed to delete keyword' });
    }
});

// Toggle keyword active status
app.patch('/api/keywords/:id/toggle', async (req, res) => {
    try {
        await pool.query(
            'UPDATE keywords SET is_active = NOT is_active WHERE id = ?',
            [req.params.id]
        );

        // Emit update to all clients
        const [keywords] = await pool.query('SELECT * FROM keywords ORDER BY created_at DESC');
        io.emit('keywords-updated', { keywords, enabled: keywordMonitoringEnabled });

        res.json({ success: true });
    } catch (error) {
        logger.error('Error toggling keyword:', error);
        res.status(500).json({ error: 'Failed to toggle keyword' });
    }
});

// Toggle monitoring enabled/disabled
app.post('/api/keywords/toggle', async (req, res) => {
    try {
        keywordMonitoringEnabled = !keywordMonitoringEnabled;
        await pool.query(
            'UPDATE keyword_settings SET enabled = ? WHERE id = 1',
            [keywordMonitoringEnabled ? 1 : 0]
        );

        // Emit update to all clients
        const [keywords] = await pool.query('SELECT * FROM keywords ORDER BY created_at DESC');
        io.emit('keywords-updated', { keywords, enabled: keywordMonitoringEnabled });

        res.json({ success: true, enabled: keywordMonitoringEnabled });
    } catch (error) {
        logger.error('Error toggling monitoring:', error);
        res.status(500).json({ error: 'Failed to toggle monitoring' });
    }
});

// Get keyword matches with pagination
app.get('/api/keywords/matches', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const offset = (page - 1) * limit;
        const keywordId = req.query.keyword_id;
        const sourceSite = req.query.source_site;

        let whereConditions = [];
        let params = [];

        if (keywordId) {
            whereConditions.push('km.keyword_id = ?');
            params.push(keywordId);
        }
        if (sourceSite) {
            whereConditions.push('a.source_site = ?');
            params.push(sourceSite);
        }

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        const [countResult] = await pool.query(
            `SELECT COUNT(*) as total FROM keyword_matches km
             JOIN articles a ON km.article_id = a.id
             ${whereClause}`,
            params
        );

        const [matches] = await pool.query(
            `SELECT km.id as match_id, km.keyword_id, km.article_id, km.matched_at, km.is_read,
                    k.keyword as keyword_text,
                    a.headline, a.source_url, a.source_site, a.published_at
             FROM keyword_matches km
             JOIN keywords k ON km.keyword_id = k.id
             JOIN articles a ON km.article_id = a.id
             ${whereClause}
             ORDER BY km.matched_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({
            matches,
            total: countResult[0].total,
            page,
            totalPages: Math.ceil(countResult[0].total / limit)
        });
    } catch (error) {
        logger.error('Error fetching matches:', error);
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

// Get keyword stats
app.get('/api/keywords/stats', async (req, res) => {
    try {
        const [totalResult] = await pool.query('SELECT COUNT(*) as count FROM keyword_matches');
        const [unreadResult] = await pool.query('SELECT COUNT(*) as count FROM keyword_matches WHERE is_read = 0');
        const [bySite] = await pool.query(
            `SELECT a.source_site, COUNT(*) as match_count
             FROM keyword_matches km
             JOIN articles a ON km.article_id = a.id
             GROUP BY a.source_site`
        );

        res.json({
            totalMatches: totalResult[0].count,
            unreadMatches: unreadResult[0].count,
            bySite
        });
    } catch (error) {
        logger.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Delete selected matches
app.delete('/api/keywords/matches', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }

        const placeholders = ids.map(() => '?').join(',');
        await pool.query(`DELETE FROM keyword_matches WHERE id IN (${placeholders})`, ids);

        io.emit('matches-deleted');
        res.json({ success: true, deleted: ids.length });
    } catch (error) {
        logger.error('Error deleting matches:', error);
        res.status(500).json({ error: 'Failed to delete matches' });
    }
});

// Delete all matches (optionally by keyword)
app.delete('/api/keywords/matches/all', async (req, res) => {
    try {
        const { keyword_id } = req.body;

        if (keyword_id) {
            await pool.query('DELETE FROM keyword_matches WHERE keyword_id = ?', [keyword_id]);
        } else {
            await pool.query('DELETE FROM keyword_matches');
        }

        io.emit('matches-cleared');
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting all matches:', error);
        res.status(500).json({ error: 'Failed to delete matches' });
    }
});

// Search existing articles for keywords
app.post('/api/keywords/search', async (req, res) => {
    try {
        const { limit = 200 } = req.body;

        const [keywords] = await pool.query('SELECT * FROM keywords WHERE is_active = 1');
        if (keywords.length === 0) {
            return res.json({ articlesSearched: 0, matchesFound: 0 });
        }

        const [articles] = await pool.query(
            'SELECT id, headline, content FROM articles ORDER BY id DESC LIMIT ?',
            [limit]
        );

        let matchesFound = 0;
        for (const article of articles) {
            const text = `${article.headline || ''} ${article.content || ''}`.toLowerCase();

            for (const kw of keywords) {
                if (text.includes(kw.keyword.toLowerCase())) {
                    try {
                        await pool.query(
                            'INSERT IGNORE INTO keyword_matches (keyword_id, article_id) VALUES (?, ?)',
                            [kw.id, article.id]
                        );
                        matchesFound++;
                    } catch (e) {
                        // Ignore duplicates
                    }
                }
            }
        }

        res.json({ articlesSearched: articles.length, matchesFound });
    } catch (error) {
        logger.error('Error searching articles:', error);
        res.status(500).json({ error: 'Failed to search articles' });
    }
});

// Reset scan position
app.post('/api/keywords/reset', async (req, res) => {
    try {
        const { lookback = 100 } = req.body;

        const [maxId] = await pool.query('SELECT MAX(id) as maxId FROM articles');
        const newPosition = Math.max(0, (maxId[0]?.maxId || 0) - lookback);

        await pool.query('UPDATE keyword_settings SET last_checked_id = ? WHERE id = 1', [newPosition]);
        lastCheckedArticleId = newPosition;

        res.json({ success: true, lastCheckedId: newPosition });
    } catch (error) {
        logger.error('Error resetting scan:', error);
        res.status(500).json({ error: 'Failed to reset scan' });
    }
});

// Keyword monitoring check (runs periodically)
async function checkNewArticlesForKeywords() {
    if (!keywordMonitoringEnabled || !isDatabaseAvailable) return;

    try {
        const [keywords] = await executeQuery('SELECT * FROM keywords WHERE is_active = 1');
        if (keywords.length === 0) return;

        const [articles] = await executeQuery(
            'SELECT id, headline, content FROM articles WHERE id > ? ORDER BY id ASC LIMIT 50',
            [lastCheckedArticleId]
        );

        if (articles.length === 0) return;

        const newMatches = [];

        for (const article of articles) {
            const text = `${article.headline || ''} ${article.content || ''}`.toLowerCase();

            for (const kw of keywords) {
                if (text.includes(kw.keyword.toLowerCase())) {
                    try {
                        const [result] = await executeQuery(
                            'INSERT IGNORE INTO keyword_matches (keyword_id, article_id) VALUES (?, ?)',
                            [kw.id, article.id]
                        );
                        if (result.affectedRows > 0) {
                            newMatches.push({
                                keyword: kw.keyword,
                                articleId: article.id,
                                headline: article.headline
                            });
                        }
                    } catch (e) {
                        // Ignore duplicates
                    }
                }
            }

            // Update last checked ID
            lastCheckedArticleId = article.id;
        }

        // Save last checked ID
        await executeQuery('UPDATE keyword_settings SET last_checked_id = ? WHERE id = 1', [lastCheckedArticleId]);

        // Emit new matches if any
        if (newMatches.length > 0) {
            io.emit('keyword-matches', newMatches);
            logger.info(`Found ${newMatches.length} new keyword matches`);
        }
    } catch (error) {
        logger.error('Error checking articles for keywords:', error);
    }
}

// Initialize dashboard_users table and seed default admin account
async function initAdminTable() {
    if (!isDatabaseAvailable) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dashboard_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // Seed default admin — INSERT IGNORE so it never overwrites a changed password
        await pool.query(
            'INSERT IGNORE INTO dashboard_users (username, password) VALUES (?, ?)',
            ['admin', 'admin321']
        );
        logger.info('Admin users table initialized');
    } catch (error) {
        logger.error('Error initializing admin users table:', error);
    }
}

// ── Scraper Scheduler ─────────────────────────────────────────────────────────

async function initScheduleTable() {
    if (!isDatabaseAvailable) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS custom_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                label VARCHAR(100) DEFAULT '',
                schedule_time TIME NOT NULL,
                scraper_ids JSON NOT NULL,
                is_active TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        logger.info('Custom schedules table initialized');
    } catch (error) {
        logger.error('Error initializing scraper_schedules table:', error);
    }
}

let schedulerCronJob = null;

function loadSchedulerCron() {
    if (schedulerCronJob) { schedulerCronJob.stop(); schedulerCronJob = null; }
    schedulerCronJob = cron.schedule('* * * * *', async () => {
        if (!isDatabaseAvailable) return;
        try {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const currentTime = `${hh}:${mm}:00`;
            const [rows] = await pool.query(
                `SELECT * FROM custom_schedules WHERE is_active = 1 AND TIME_FORMAT(schedule_time,'%H:%i:%s') = ?`,
                [currentTime]
            );
            for (const row of rows) {
                let ids = [];
                try { ids = typeof row.scraper_ids === 'string' ? JSON.parse(row.scraper_ids) : row.scraper_ids; } catch(e) {}
                for (const sid of ids) {
                    if (SCRAPERS[sid] && SCRAPERS[sid].status !== 'running') {
                        logger.info(`[Scheduler] Starting ${sid} (schedule id=${row.id} "${row.label}" at ${hh}:${mm})`);
                        startScraper(sid);
                    }
                }
            }
        } catch (err) {
            logger.error('Scheduler cron error:', err);
        }
    });
    logger.info('Scheduler cron started (checks every minute)');
}

// GET all schedules
app.get('/api/schedules', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM custom_schedules ORDER BY schedule_time ASC');
        res.json(rows.map(r => ({
            ...r,
            scraper_ids: typeof r.scraper_ids === 'string' ? JSON.parse(r.scraper_ids) : r.scraper_ids
        })));
    } catch (err) {
        logger.error('Error fetching schedules:', err);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// POST create schedule
app.post('/api/schedules', async (req, res) => {
    try {
        const { label = '', schedule_time, scraper_ids, is_active = 1 } = req.body;
        if (!schedule_time || !Array.isArray(scraper_ids) || scraper_ids.length === 0) {
            return res.status(400).json({ error: 'schedule_time and scraper_ids[] are required' });
        }
        const [result] = await pool.query(
            'INSERT INTO custom_schedules (label, schedule_time, scraper_ids, is_active) VALUES (?,?,?,?)',
            [label, schedule_time, JSON.stringify(scraper_ids), is_active]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        logger.error('Error creating schedule:', err);
        res.status(500).json({ error: 'Failed to create schedule' });
    }
});

// PUT update schedule
app.put('/api/schedules/:id', async (req, res) => {
    try {
        const { label, schedule_time, scraper_ids, is_active } = req.body;
        const id = parseInt(req.params.id);
        const [existing] = await pool.query('SELECT id FROM custom_schedules WHERE id = ?', [id]);
        if (!existing.length) return res.status(404).json({ error: 'Schedule not found' });
        await pool.query(
            'UPDATE custom_schedules SET label=?, schedule_time=?, scraper_ids=?, is_active=? WHERE id=?',
            [label || '', schedule_time, JSON.stringify(scraper_ids), is_active ? 1 : 0, id]
        );
        res.json({ success: true });
    } catch (err) {
        logger.error('Error updating schedule:', err);
        res.status(500).json({ error: 'Failed to update schedule' });
    }
});

// PATCH toggle active
app.patch('/api/schedules/:id/toggle', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [rows] = await pool.query('SELECT is_active FROM custom_schedules WHERE id = ?', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
        const newVal = rows[0].is_active ? 0 : 1;
        await pool.query('UPDATE custom_schedules SET is_active = ? WHERE id = ?', [newVal, id]);
        res.json({ success: true, is_active: newVal });
    } catch (err) {
        logger.error('Error toggling schedule:', err);
        res.status(500).json({ error: 'Failed to toggle schedule' });
    }
});

// DELETE schedule
app.delete('/api/schedules/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM custom_schedules WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        logger.error('Error deleting schedule:', err);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// Initialize autorun table and seed defaults
async function initAutorunTable() {
    if (!isDatabaseAvailable) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scraper_autorun (
                site VARCHAR(50) PRIMARY KEY,
                autorun TINYINT(1) DEFAULT 1
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // INSERT IGNORE — only seeds on first creation, never overwrites existing values
        const scraperIds = Object.keys(SCRAPERS);
        for (const site of scraperIds) {
            await pool.query('INSERT IGNORE INTO scraper_autorun (site, autorun) VALUES (?, 1)', [site]);
        }
        logger.info('Autorun table initialized');
    } catch (error) {
        logger.error('Error initializing autorun table:', error);
    }
}

// Initialize database and keyword tables on startup
(async () => {
    isDatabaseAvailable = await testDatabaseConnection();
    if (isDatabaseAvailable) {
        await initKeywordTables();
        await initAutorunTable();
        await initAdminTable();
        await initScheduleTable();
        loadSchedulerCron();
    } else {
        logger.warn('Server starting without database connection. Some features will be disabled.');
        logger.warn('Database operations will be retried automatically.');
    }
})();

// Periodically check database connection and retry if needed (every 60 seconds)
setInterval(async () => {
    if (!isDatabaseAvailable) {
        logger.info('Attempting to reconnect to database...');
        isDatabaseAvailable = await testDatabaseConnection(1, 1000);
        if (isDatabaseAvailable) {
            logger.info('Database connection restored');
            await initKeywordTables();
            await initAutorunTable();
        }
    }
}, 60000);

// Check for new articles every 30 seconds
setInterval(checkNewArticlesForKeywords, 30000);

// =============================================================
// FACE SEARCH API (Find People)
// =============================================================
const _winVenv = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
const _linuxVenv = path.join(__dirname, '.venv', 'bin', 'python3');
const VENV_PYTHON = process.env.PYTHON_PATH ||
    (fs.existsSync(_winVenv) ? _winVenv : fs.existsSync(_linuxVenv) ? _linuxVenv : 'python3');

// Multer setup for face search uploads
const faceUploadDir = path.join(__dirname, 'uploads_temp');
if (!fs.existsSync(faceUploadDir)) fs.mkdirSync(faceUploadDir);
const faceUpload = multer({ dest: faceUploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

let faceIndexBuildProcess = null;
let autoBuildThreshold = 0; // Auto-build disabled by default
let autoBuildIntervalId = null; // Store interval ID to start/stop

// Auto-build face index check (runs every 2 minutes)
async function checkAndTriggerAutoBuild() {
    // Skip if build already in progress
    if (faceIndexBuildProcess !== null) {
        return;
    }
    
    logger.info(`🔍 Checking for new images to index (threshold: ${autoBuildThreshold})...`);
    
    try {
        const checkResult = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u', path.join(__dirname, 'face_search.py'), '--check-new'
            ], { cwd: __dirname });
            let stdout = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.on('close', (code) => {
                if (code === 0 && stdout.trim()) {
                    try { resolve(JSON.parse(stdout.trim())); } catch (e) { resolve(null); }
                } else { resolve(null); }
            });
            proc.on('error', () => resolve(null));
        });
        
        if (checkResult && checkResult.new_images >= autoBuildThreshold) {
            logger.info(`🔄 Auto-build triggered: ${checkResult.new_images} new images >= threshold ${autoBuildThreshold}`);
            
            // Start the build process
            faceIndexBuildProcess = spawn(VENV_PYTHON, [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--build-index'
            ], { cwd: __dirname });

            let output = '';

            faceIndexBuildProcess.stdout.on('data', (data) => {
                output += data.toString();
                io.emit('face-index-progress', { message: data.toString().trim() });
            });

            faceIndexBuildProcess.stderr.on('data', (data) => {
                output += data.toString();
            });

            faceIndexBuildProcess.on('close', (code) => {
                faceIndexBuildProcess = null;
                io.emit('face-index-complete', { success: code === 0, output: output.trim() });
                logger.info(`✅ Auto-build face index finished with code ${code}`);
            });

            faceIndexBuildProcess.on('error', (err) => {
                faceIndexBuildProcess = null;
                io.emit('face-index-complete', { success: false, output: err.message });
                logger.error('❌ Auto-build face index error:', err);
            });
        } else if (checkResult) {
            logger.info(`✓ ${checkResult.new_images} new image(s) found (threshold: ${autoBuildThreshold})`);
        }
    } catch (err) {
        logger.error('Auto-build check error:', err);
    }
}

// Start/stop auto-build interval based on threshold
function manageAutoBuildInterval() {
    // Stop existing interval if any
    if (autoBuildIntervalId) {
        clearInterval(autoBuildIntervalId);
        autoBuildIntervalId = null;
        logger.info('Auto-build interval stopped');
    }
    
    // Start new interval if threshold > 0
    if (autoBuildThreshold > 0) {
        autoBuildIntervalId = setInterval(checkAndTriggerAutoBuild, 120000); // 2 minutes
        logger.info(`Auto-build interval started (threshold: ${autoBuildThreshold})`);
    }
}

// POST /api/face-search - Upload image and search for matching faces
app.post('/api/face-search', faceUpload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const threshold = parseFloat(req.body.threshold) || 0.4;
    const limit = parseInt(req.body.limit) || 20;
    const imagePath = req.file.path;

    try {
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--search', imagePath,
                '--threshold', String(threshold),
                '--limit', String(limit)
            ], { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    // Try to parse stdout for JSON error messages even on non-zero exit
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        // Clean up temp file
        try { fs.unlinkSync(imagePath); } catch (e) {}

        // Parse JSON output from Python
        let matches;
        try {
            matches = JSON.parse(result);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse search results', detail: result });
        }

        if (matches.error) {
            return res.status(400).json(matches);
        }

        // Enrich matches with article data from DB
        if (matches.length > 0) {
            const imageNames = matches.map(m => m.image);
            const placeholders = imageNames.map(() => '?').join(',');
            try {
                const [rows] = await pool.query(
                    `SELECT id, headline, source_url, source_site, published_at, image_name
                     FROM articles WHERE image_name IN (${placeholders})`,
                    imageNames
                );
                const articleMap = {};
                for (const row of rows) {
                    articleMap[row.image_name] = row;
                }
                for (const match of matches) {
                    const article = articleMap[match.image];
                    if (article) {
                        match.article_id = article.id;
                        match.headline = article.headline;
                        match.source_url = article.source_url;
                        match.source_site = article.source_site;
                        match.published_at = article.published_at;
                    }
                }
            } catch (dbErr) {
                logger.error('DB enrichment error:', dbErr);
            }
        }

        res.json({ matches, count: matches.length });

    } catch (err) {
        // Clean up temp file on error
        try { fs.unlinkSync(imagePath); } catch (e) {}
        logger.error('Face search error:', err);
        res.status(500).json({ error: err.message || 'Face search failed' });
    }
});

// POST /api/face-search-multi - Upload multiple images and search for matching faces
app.post('/api/face-search-multi', faceUpload.array('images', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
    }

    const threshold = parseFloat(req.body.threshold) || 0.4;
    const limit = parseInt(req.body.limit) || 20;
    const strategy = req.body.strategy || 'hybrid';
    const imagePaths = req.files.map(f => f.path);

    try {
        const result = await new Promise((resolve, reject) => {
            const args = [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--search-multi',
                ...imagePaths,
                '--threshold', String(threshold),
                '--limit', String(limit),
                '--strategy', strategy
            ];

            const proc = spawn(VENV_PYTHON, args, { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        // Clean up temp files
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }

        // Parse JSON output from Python
        let matches;
        try {
            matches = JSON.parse(result);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse search results', detail: result });
        }

        if (matches.error) {
            return res.status(400).json(matches);
        }

        // Enrich matches with article data from DB
        if (matches.length > 0) {
            const imageNames = matches.map(m => m.image);
            const placeholders = imageNames.map(() => '?').join(',');
            try {
                const [rows] = await pool.query(
                    `SELECT id, headline, source_url, source_site, published_at, image_name
                     FROM articles WHERE image_name IN (${placeholders})`,
                    imageNames
                );
                const articleMap = {};
                for (const row of rows) {
                    articleMap[row.image_name] = row;
                }
                for (const match of matches) {
                    const article = articleMap[match.image];
                    if (article) {
                        match.article_id = article.id;
                        match.headline = article.headline;
                        match.source_url = article.source_url;
                        match.source_site = article.source_site;
                        match.published_at = article.published_at;
                    }
                }
            } catch (dbErr) {
                logger.error('DB enrichment error:', dbErr);
            }
        }

        res.json({
            matches,
            count: matches.length,
            images_processed: req.files.length,
            strategy
        });

    } catch (err) {
        // Clean up temp files on error
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        logger.error('Multi-image face search error:', err);
        res.status(500).json({ error: err.message || 'Face search failed' });
    }
});

// POST /api/face-index/build - Build/update face index (background)
app.post('/api/face-index/build', (req, res) => {
    if (faceIndexBuildProcess) {
        return res.status(409).json({ error: 'Index build already in progress' });
    }

    faceIndexBuildProcess = spawn(VENV_PYTHON, [
        '-u',
        path.join(__dirname, 'face_search.py'),
        '--build-index'
    ], { cwd: __dirname });

    let output = '';

    faceIndexBuildProcess.stdout.on('data', (data) => {
        output += data.toString();
        io.emit('face-index-progress', { message: data.toString().trim() });
    });

    faceIndexBuildProcess.stderr.on('data', (data) => {
        output += data.toString();
    });

    faceIndexBuildProcess.on('close', (code) => {
        faceIndexBuildProcess = null;
        io.emit('face-index-complete', { success: code === 0, output: output.trim() });
        logger.info(`Face index build finished with code ${code}`);
    });

    faceIndexBuildProcess.on('error', (err) => {
        faceIndexBuildProcess = null;
        io.emit('face-index-complete', { success: false, output: err.message });
    });

    res.json({ status: 'started', message: 'Index build started in background' });
});

// GET /api/face-index/status - Get face index status
app.get('/api/face-index/status', async (req, res) => {
    const metaFile = path.join(__dirname, 'face_index_meta.json');
    const indexFile = path.join(__dirname, 'face_index.pkl');

    const status = {
        exists: fs.existsSync(indexFile),
        building: faceIndexBuildProcess !== null,
        new_images: 0,
        auto_build_threshold: autoBuildThreshold,
    };

    if (fs.existsSync(metaFile)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            Object.assign(status, meta);
        } catch (e) {}
    }

    // Quick check for new unindexed images (no model loading, fast)
    try {
        const checkResult = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u', path.join(__dirname, 'face_search.py'), '--check-new'
            ], { cwd: __dirname });
            let stdout = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.on('close', (code) => {
                if (code === 0 && stdout.trim()) {
                    try { resolve(JSON.parse(stdout.trim())); } catch (e) { resolve(null); }
                } else { resolve(null); }
            });
            proc.on('error', () => resolve(null));
        });
        if (checkResult) {
            status.new_images = checkResult.new_images || 0;
        }
    } catch (e) {}

    res.json(status);
});

// POST /api/face-index/auto-build-threshold - Set auto-build threshold
app.post('/api/face-index/auto-build-threshold', (req, res) => {
    const threshold = parseInt(req.body.threshold);
    
    if (isNaN(threshold) || threshold < 0) {
        return res.status(400).json({ error: 'Invalid threshold value' });
    }
    
    autoBuildThreshold = threshold;
    manageAutoBuildInterval(); // Start or stop interval based on new threshold
    logger.info(`Auto-build threshold set to: ${threshold}`);
    
    res.json({ 
        success: true, 
        threshold: autoBuildThreshold,
        message: threshold > 0 
            ? `Auto-build enabled: will trigger at ${threshold} new images`
            : 'Auto-build disabled'
    });
});

// POST /api/face-relation-search - Find people who frequently appear with target person
app.post('/api/face-relation-search', faceUpload.array('images', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
    }

    const threshold = parseFloat(req.body.threshold) || 0.4;
    const strategy = req.body.strategy || 'hybrid';
    const clusterThreshold = parseFloat(req.body.clusterThreshold) || 0.35;
    const imagePaths = req.files.map(f => f.path);

    try {
        const result = await new Promise((resolve, reject) => {
            const args = [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--relation-search',
                ...imagePaths,
                '--threshold', String(threshold),
                '--strategy', strategy,
                '--cluster-threshold', String(clusterThreshold)
            ];

            const proc = spawn(VENV_PYTHON, args, { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        // Clean up temp files
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }

        let data;
        try {
            data = JSON.parse(result);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse search results', detail: result });
        }

        if (data.error) {
            return res.status(400).json(data);
        }

        // Enrich associates with article data
        if (data.associates && data.associates.length > 0) {
            for (const assoc of data.associates) {
                const imageNames = assoc.images.map(img => img.image);
                if (imageNames.length > 0) {
                    const placeholders = imageNames.map(() => '?').join(',');
                    try {
                        const [rows] = await pool.query(
                            `SELECT id, headline, source_url, source_site, published_at, image_name
                             FROM articles WHERE image_name IN (${placeholders})`,
                            imageNames
                        );
                        const articleMap = {};
                        for (const row of rows) {
                            articleMap[row.image_name] = row;
                        }
                        for (const img of assoc.images) {
                            const article = articleMap[img.image];
                            if (article) {
                                img.article_id = article.id;
                                img.headline = article.headline;
                                img.source_url = article.source_url;
                                img.source_site = article.source_site;
                                img.published_at = article.published_at;
                            }
                        }
                    } catch (dbErr) {
                        logger.error('DB enrichment error:', dbErr);
                    }
                }
            }
        }

        res.json(data);

    } catch (err) {
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        logger.error('Relation search error:', err);
        res.status(500).json({ error: err.message || 'Relation search failed' });
    }
});

// POST /api/face-pair-search - Find images where two people appear together
app.post('/api/face-pair-search', faceUpload.fields([
    { name: 'imagesA', maxCount: 10 },
    { name: 'imagesB', maxCount: 10 }
]), async (req, res) => {
    if (!req.files || !req.files.imagesA || !req.files.imagesB) {
        return res.status(400).json({ error: 'Both Person A and Person B images required' });
    }

    const threshold = parseFloat(req.body.threshold) || 0.4;
    const pathsA = req.files.imagesA.map(f => f.path);
    const pathsB = req.files.imagesB.map(f => f.path);

    try {
        const result = await new Promise((resolve, reject) => {
            const args = [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--pair-search-a', ...pathsA,
                '--pair-search-b', ...pathsB,
                '--threshold', String(threshold)
            ];

            const proc = spawn(VENV_PYTHON, args, { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        // Clean up temp files
        for (const path of [...pathsA, ...pathsB]) {
            try { fs.unlinkSync(path); } catch (e) {}
        }

        let data;
        try {
            data = JSON.parse(result);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse search results', detail: result });
        }

        if (data.error) {
            return res.status(400).json(data);
        }

        // Enrich matches with article data
        if (data.matches && data.matches.length > 0) {
            const imageNames = data.matches.map(m => m.image);
            const placeholders = imageNames.map(() => '?').join(',');
            try {
                const [rows] = await pool.query(
                    `SELECT id, headline, source_url, source_site, published_at, image_name
                     FROM articles WHERE image_name IN (${placeholders})`,
                    imageNames
                );
                const articleMap = {};
                for (const row of rows) {
                    articleMap[row.image_name] = row;
                }
                for (const match of data.matches) {
                    const article = articleMap[match.image];
                    if (article) {
                        match.article_id = article.id;
                        match.headline = article.headline;
                        match.source_url = article.source_url;
                        match.source_site = article.source_site;
                        match.published_at = article.published_at;
                    }
                }
            } catch (dbErr) {
                logger.error('DB enrichment error:', dbErr);
            }
        }

        res.json(data);

    } catch (err) {
        for (const path of [...pathsA, ...pathsB]) {
            try { fs.unlinkSync(path); } catch (e) {}
        }
        logger.error('Pair search error:', err);
        res.status(500).json({ error: err.message || 'Pair search failed' });
    }
});

// POST /api/face-names/save - Save a named face identity
app.post('/api/face-names/save', faceUpload.array('images', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
    }

    const name = req.body.name;
    if (!name || name.trim().length === 0) {
        for (const file of req.files) {
            try { fs.unlinkSync(file.path); } catch (e) {}
        }
        return res.status(400).json({ error: 'Name is required' });
    }

    const imagePaths = req.files.map(f => f.path);

    try {
        const result = await new Promise((resolve, reject) => {
            const args = [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--save-name', name.trim(),
                '--embeddings-from', ...imagePaths
            ];

            const proc = spawn(VENV_PYTHON, args, { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        // Clean up temp files
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }

        const data = JSON.parse(result);
        res.json(data);

    } catch (err) {
        for (const imagePath of imagePaths) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        logger.error('Save name error:', err);
        res.status(500).json({ error: err.message || 'Failed to save name' });
    }
});

// GET /api/face-names/list - List all saved named faces
app.get('/api/face-names/list', async (req, res) => {
    try {
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--list-names'
            ], { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr || `Process exited with code ${code}`));
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        const data = JSON.parse(result);
        res.json(data);

    } catch (err) {
        logger.error('List names error:', err);
        res.status(500).json({ error: err.message || 'Failed to list names' });
    }
});

// DELETE /api/face-names/:name - Delete a named face identity
app.delete('/api/face-names/:name', async (req, res) => {
    const name = req.params.name;

    try {
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--delete-name', name
            ], { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr || `Process exited with code ${code}`));
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        const data = JSON.parse(result);
        res.json(data);

    } catch (err) {
        logger.error('Delete name error:', err);
        res.status(500).json({ error: err.message || 'Failed to delete name' });
    }
});

// POST /api/face-search-by-name - Search by saved name
app.post('/api/face-search-by-name', async (req, res) => {
    const name = req.body.name;
    const threshold = parseFloat(req.body.threshold) || 0.4;
    const limit = parseInt(req.body.limit) || 20;

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Name is required' });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, [
                '-u',
                path.join(__dirname, 'face_search.py'),
                '--search-name', name.trim(),
                '--threshold', String(threshold),
                '--limit', String(limit)
            ], { cwd: __dirname });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(stderr || `Process exited with code ${code}`));
                    }
                } else {
                    resolve(stdout.trim());
                }
            });

            proc.on('error', (err) => reject(err));
        });

        let matches;
        try {
            matches = JSON.parse(result);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse search results', detail: result });
        }

        if (matches.error) {
            return res.status(400).json(matches);
        }

        // Enrich matches with article data
        if (matches.length > 0) {
            const imageNames = matches.map(m => m.image);
            const placeholders = imageNames.map(() => '?').join(',');
            try {
                const [rows] = await pool.query(
                    `SELECT id, headline, source_url, source_site, published_at, image_name
                     FROM articles WHERE image_name IN (${placeholders})`,
                    imageNames
                );
                const articleMap = {};
                for (const row of rows) {
                    articleMap[row.image_name] = row;
                }
                for (const match of matches) {
                    const article = articleMap[match.image];
                    if (article) {
                        match.article_id = article.id;
                        match.headline = article.headline;
                        match.source_url = article.source_url;
                        match.source_site = article.source_site;
                        match.published_at = article.published_at;
                    }
                }
            } catch (dbErr) {
                logger.error('DB enrichment error:', dbErr);
            }
        }

        res.json({ matches, count: matches.length });

    } catch (err) {
        logger.error('Search by name error:', err);
        res.status(500).json({ error: err.message || 'Search by name failed' });
    }
});

// GET /api/article/by-image/:imageName - Get full article details by image name
app.get('/api/article/by-image/:imageName', async (req, res) => {
    const imageName = req.params.imageName;

    try {
        const [rows] = await pool.query(
            `SELECT id, headline, image_name, source_site, source_url,
                    category, published_at, tags, content
             FROM articles
             WHERE image_name = ?
             LIMIT 1`,
            [imageName]
        );

        if (rows.length === 0) {
            return res.json({
                found: false,
                image: imageName,
                message: 'No article data found for this image'
            });
        }

        res.json({ found: true, article: rows[0] });
    } catch (err) {
        logger.error('Error fetching article by image:', err);
        res.status(500).json({ error: 'Failed to fetch article details' });
    }
});

// =============================================================
// EVENT CLUSTERING API
// =============================================================

let clusteringProcess = null;

// POST /api/clustering/run - Run event clustering
app.post('/api/clustering/run', (req, res) => {
    if (clusteringProcess) {
        return res.status(409).json({ error: 'Clustering already in progress' });
    }

    const hours = parseInt(req.body.hours) || 24;
    const threshold = parseFloat(req.body.threshold) || 0.75;
    const maxArticles = req.body.maxArticles || null;

    const clusteringScript = path.join(__dirname, 'event-clustering', 'cluster_service.py');
    const args = ['-u', clusteringScript, '--hours', String(hours), '--threshold', String(threshold)];
    
    if (maxArticles) {
        args.push('--max-articles', String(maxArticles));
    }

    clusteringProcess = spawn(VENV_PYTHON, args, { 
        cwd: path.join(__dirname, 'event-clustering'),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let output = '';

    clusteringProcess.stdout.setEncoding('utf8');
    clusteringProcess.stderr.setEncoding('utf8');
    
    clusteringProcess.stdout.on('data', (data) => {
        output += data;
        io.emit('clustering-progress', { message: data.trim() });
    });

    clusteringProcess.stderr.on('data', (data) => {
        output += data;
    });

    clusteringProcess.on('close', (code) => {
        clusteringProcess = null;
        io.emit('clustering-complete', { success: code === 0, output: output.trim() });
        logger.info(`Event clustering finished with code ${code}`);
    });

    clusteringProcess.on('error', (err) => {
        clusteringProcess = null;
        io.emit('clustering-complete', { success: false, output: err.message });
        logger.error('Event clustering error:', err);
    });

    res.json({ status: 'started', message: 'Clustering started' });
});

// POST /api/clustering/cancel - Kill any stuck/running clustering process
app.post('/api/clustering/cancel', (req, res) => {
    if (!clusteringProcess) {
        return res.json({ success: true, message: 'No clustering process running' });
    }
    try {
        clusteringProcess.kill('SIGTERM');
    } catch (_) {}
    clusteringProcess = null;
    io.emit('clustering-complete', { success: false, output: 'Clustering cancelled by user' });
    res.json({ success: true, message: 'Clustering process cancelled' });
});

// GET /api/clustering/stats - Get clustering statistics
app.get('/api/clustering/stats', async (req, res) => {
    try {
        const statsScript = path.join(__dirname, 'event-clustering', 'get_stats.py');
        
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, ['-u', statsScript], 
                { cwd: path.join(__dirname, 'event-clustering'), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            
            let stdout = '';
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (data) => { stdout += data; });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error('Failed to get stats'));
                }
            });
            proc.on('error', reject);
        });

        const stats = JSON.parse(result);
        res.json({ success: true, stats });
    } catch (error) {
        logger.error('Error fetching clustering stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/clustering/clusters - Get list of clusters
app.get('/api/clustering/clusters', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const clustersScript = path.join(__dirname, 'event-clustering', 'get_clusters.py');
        
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, 
                ['-u', clustersScript, '--limit', String(limit), '--offset', String(offset)],
                { cwd: path.join(__dirname, 'event-clustering'), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            
            let stdout = '';
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (data) => { stdout += data; });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error('Failed to get clusters'));
                }
            });
            proc.on('error', reject);
        });

        const clusters = JSON.parse(result);
        res.json({ success: true, clusters });
    } catch (error) {
        logger.error('Error fetching clusters:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/clustering/cluster/:id - Get cluster details
app.get('/api/clustering/cluster/:id', async (req, res) => {
    try {
        const clusterId = req.params.id;
        const detailScript = path.join(__dirname, 'event-clustering', 'get_cluster_detail.py');
        
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(VENV_PYTHON, 
                ['-u', detailScript, '--id', clusterId],
                { cwd: path.join(__dirname, 'event-clustering'), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            
            let stdout = '';
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (data) => { stdout += data; });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error('Failed to get cluster details'));
                }
            });
            proc.on('error', reject);
        });

        const cluster = JSON.parse(result);
        res.json({ success: true, cluster });
    } catch (error) {
        logger.error('Error fetching cluster details:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/clustering/status - Get clustering process status
app.get('/api/clustering/status', (req, res) => {
    res.json({ 
        running: clusteringProcess !== null,
        message: clusteringProcess ? 'Clustering in progress' : 'No clustering running'
    });
});

// ============================================================================
// Cycle Time Configuration API
// ============================================================================

const CYCLE_CONFIG_PATH = path.join(__dirname, 'scraper_cycle_config.json');

// Default cycle times for all scrapers
const DEFAULT_CYCLE_TIMES = {
    bdnews24: 600,
    prothomalo: 600,
    jugantor: 600,
    jagonews24: 600,
    ittefaq: 600,
    kalbela: 600,
    dhakapost: 600,
    desh: 60
};

// Load cycle configuration
function loadCycleConfig() {
    try {
        if (fs.existsSync(CYCLE_CONFIG_PATH)) {
            const data = fs.readFileSync(CYCLE_CONFIG_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logger.error('Error loading cycle config:', error);
    }

    // Return default config
    return {
        global_cycle_time: null,
        scrapers: Object.keys(DEFAULT_CYCLE_TIMES).reduce((acc, key) => {
            acc[key] = null;
            return acc;
        }, {})
    };
}

// Save cycle configuration
function saveCycleConfig(config) {
    try {
        fs.writeFileSync(CYCLE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('Error saving cycle config:', error);
        return false;
    }
}

// GET /api/cycle-config - Get current configuration
app.get('/api/cycle-config', (req, res) => {
    try {
        const config = loadCycleConfig();
        res.json(config);
    } catch (error) {
        logger.error('Error in GET /api/cycle-config:', error);
        res.status(500).json({ error: 'Failed to load configuration' });
    }
});

// POST /api/cycle-config - Update configuration
app.post('/api/cycle-config', (req, res) => {
    try {
        const config = req.body;
        
        // Validate config structure
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ error: 'Invalid configuration format' });
        }

        // Save configuration
        if (saveCycleConfig(config)) {
            logger.info('Cycle configuration updated');
            res.json({ success: true, message: 'Configuration saved successfully' });
        } else {
            res.status(500).json({ error: 'Failed to save configuration' });
        }
    } catch (error) {
        logger.error('Error in POST /api/cycle-config:', error);
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Socket.IO connection
io.on('connection', (socket) => {
    logger.info('Client connected');

    // Send current status to new client
    socket.emit('scrapers-status', getAllScrapersStatus());

    socket.on('disconnect', () => {
        logger.info('Client disconnected');
    });
});

// Periodic status update
setInterval(() => {
    loadLastRunTimes();
    io.emit('scrapers-status', getAllScrapersStatus());
}, 5000);

// Auto-reload last run times every minute
cron.schedule('* * * * *', () => {
    loadLastRunTimes();
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down scraper manager...');
    
    Object.keys(SCRAPERS).forEach(scraperId => {
        stopScraper(scraperId);
    });
    
    setTimeout(() => {
        process.exit(0);
    }, 3000);
});

// Initialize and start server
loadLastRunTimes();

server.listen(PORT, () => {
    logger.info(`Scraper Manager running on http://localhost:${PORT}`);
    console.log(`\n${'='.repeat(70)}`);
    console.log('SCRAPER MANAGEMENT SYSTEM');
    console.log(`${'='.repeat(70)}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api/scrapers`);
    console.log(`${'='.repeat(70)}\n`);
});
