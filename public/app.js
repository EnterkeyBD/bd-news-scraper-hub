// Connect to Socket.IO
const socket = io();

// Test socket connection
socket.on('connect', () => {
    console.log('✅ Socket.IO connected!', socket.id);
    console.log('🔌 Socket connected - Real-time updates enabled');
});

socket.on('disconnect', () => {
    console.log('❌ Socket.IO disconnected');
    console.log('⚠️ Real-time updates disabled - will resume on reconnect');
});

// DOM elements
const scrapersContainer = document.getElementById('scrapers-container');
const totalScrapersEl = document.getElementById('total-scrapers');
const runningScrapersEl = document.getElementById('running-scrapers');
const stoppedScrapersEl = document.getElementById('stopped-scrapers');
const totalErrorsEl = document.getElementById('total-errors');
const startAllBtn = document.getElementById('start-all-btn');
const stopAllBtn = document.getElementById('stop-all-btn');
const outputModal = document.getElementById('output-modal');
const modalTitle = document.getElementById('modal-title');
const outputLogs = document.getElementById('output-logs');
const closeModal = document.querySelector('.close');
const categoriesModal = document.getElementById('categories-modal');
const categoriesModalTitle = document.getElementById('categories-modal-title');
const categoriesTbody = document.getElementById('categories-tbody');
const closeCategoriesModal = document.querySelector('.close-categories');
const runningSidebar = document.getElementById('running-sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarList = document.getElementById('sidebar-list');
const sidebarRunningCount = document.getElementById('sidebar-running-count');

// Sidebar toggle functionality
if (sidebarToggle && runningSidebar) {
    sidebarToggle.addEventListener('click', function() {
        runningSidebar.classList.toggle('collapsed');
    });
}

let currentScraperId = null;
let outputBuffer = {};
let currentCategoriesScraperId = null;

// Initialize output buffers
socket.on('connect', () => {
    console.log('Connected to server via Socket.IO');
    console.log('Socket ID:', socket.id);
    loadScrapers();
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
});

// --- Only call updateDashboard on initial load and manual refresh ---
let dashboardInitialized = false;

// Initial load
window.addEventListener('DOMContentLoaded', () => {
    dashboardInitialized = false;
    loadScrapers();

    // Dropdown toggle functionality
    const settingsBtn = document.getElementById('settings-btn');
    const settingsMenu = document.getElementById('settings-menu');

    if (settingsBtn && settingsMenu) {
        settingsBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            settingsMenu.classList.toggle('show');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
            if (!settingsBtn.contains(e.target) && !settingsMenu.contains(e.target)) {
                settingsMenu.classList.remove('show');
            }
        });
    }
});


// Handle scraper status updates
socket.on('scrapers-status', (scrapers) => {
    if (!dashboardInitialized) {
        updateDashboard(scrapers);
        dashboardInitialized = true;
    } else {
        // Only update status badges and non-stat fields
        Object.keys(scrapers).forEach(scraperId => {
            const scraper = scrapers[scraperId];
            const card = document.querySelector(`[data-scraper-id="${scraperId}"]`);
            if (card) {
                // Update status badge
                const statusBadge = card.querySelector('.status-badge');
                if (statusBadge) {
                    statusBadge.className = `status-badge status-${scraper.status}`;
                    statusBadge.textContent = scraper.status;
                }
                // Update last run
                const scraperInfo = card.querySelector('.scraper-info');
                if (scraperInfo) {
                    const lastRunValue = scraperInfo.querySelector('.info-row:nth-child(1) .info-value');
                    if (lastRunValue) {
                        lastRunValue.textContent = scraper.lastRun || 'Never';
                    }
                }
            }
        });
    }
});

// Real-time stat updates: only update values, never rebuild card
socket.on('scraper-stats', (data) => {
    console.log('📊 RECEIVED scraper-stats:', data.scraperId, 'count:', data.stats?.articlesProcessed);
    updateScraperStats(data.scraperId, data.stats);
    // Also update sidebar article count
    const sidebarItem = document.querySelector(`.sidebar-item[data-scraper-id="${data.scraperId}"]`);
    if (sidebarItem) {
        const articlesEl = sidebarItem.querySelector('.sidebar-item-articles');
        if (articlesEl) {
            articlesEl.innerHTML = `📰 ${data.stats?.articlesProcessed || 0}`;
        }
    }
});

// Handle scraper output
socket.on('scraper-output', (data) => {
    const { scraperId, output, type } = data;
    
    if (!outputBuffer[scraperId]) {
        outputBuffer[scraperId] = [];
    }
    
    outputBuffer[scraperId].push({
        type,
        message: output,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last 100 entries
    if (outputBuffer[scraperId].length > 100) {
        outputBuffer[scraperId].shift();
    }
    
    // Update modal if currently viewing this scraper
    if (currentScraperId === scraperId && outputModal.style.display === 'block') {
        displayOutput(scraperId);
    }
});

// Handle scraper status change
socket.on('scraper-status', (data) => {
    console.log('Scraper status changed:', data);
    
    // Update specific scraper card status without full reload
    const scraperCard = document.querySelector(`.scraper-card[data-scraper-id="${data.scraperId}"]`);
    if (scraperCard) {
        // Update status badge
        const statusBadge = scraperCard.querySelector('.status-badge');
        if (statusBadge) {
            statusBadge.className = `status-badge status-${data.status}`;
            statusBadge.textContent = data.status;
        }
        
        // If scraper stopped, remove status box immediately
        if (data.status === 'stopped') {
            const scraperBody = scraperCard.querySelector('.scraper-body');
            if (scraperBody) {
                const statusBox = scraperBody.querySelector('.current-status');
                if (statusBox) {
                    console.log('Removing status box for stopped scraper:', data.scraperId);
                    statusBox.remove();
                }
            }
            
            // Update action buttons for stopped state
            const actionsContainer = scraperCard.querySelector('.scraper-actions');
            if (actionsContainer) {
                actionsContainer.innerHTML = `
                    <button class="btn btn-success" onclick="startScraper('${data.scraperId}')">Start</button>
                    <button class="btn btn-info" onclick="showOutput('${data.scraperId}', 'Scraper')">View Logs</button>
                `;
            }
        } else if (data.status === 'running') {
            // Update action buttons for running state
            const actionsContainer = scraperCard.querySelector('.scraper-actions');
            if (actionsContainer) {
                actionsContainer.innerHTML = `
                    <button class="btn btn-danger" onclick="stopScraper('${data.scraperId}')">Stop</button>
                    <button class="btn btn-warning" onclick="restartScraper('${data.scraperId}')">Restart</button>
                    <button class="btn btn-info" onclick="showOutput('${data.scraperId}', 'Scraper')">View Logs</button>
                `;
            }
        }
    }
    
    // Don't call loadScrapers() - it destroys elements we're trying to update in real-time
    // Only update the sidebar
    updateRunningSidebar();
});

// Note: scraper-stats handler is defined above (single handler to avoid duplicates)

// Handle scraper status updates (finding/extracting/waiting)
socket.on('scraper-status-update', (data) => {
    console.log('🔔 === SOCKET EVENT RECEIVED ===');
    console.log('Event: scraper-status-update');
    console.log('Data:', JSON.stringify(data, null, 2));
    console.log('ScraperId:', data?.scraperId);
    console.log('CurrentStatus:', data?.currentStatus);
    
    if (data && data.scraperId && data.currentStatus) {
        console.log('✅ Valid data, calling updateScraperCurrentStatus...');
        updateScraperCurrentStatus(data.scraperId, data.currentStatus);
        updateSidebarStatus(data.scraperId, data.currentStatus);
    } else {
        console.error('❌ Invalid scraper status update data:', data);
    }
    console.log('=================================');
});

// Handle scraper errors
socket.on('scraper-error', (data) => {
    console.error('Scraper error:', data);
    showNotification(`Error in ${data.scraperId}: ${data.error}`, 'error');
});

// Buffer for pending stat updates if card/stat element is missing
const pendingStats = {};

// Update scraper stats without full reload, with buffering
function updateScraperStats(scraperId, stats) {
    if (!stats) {
        console.warn(`⏳ No stats provided for ${scraperId}`);
        return;
    }

    const scraperCard = document.querySelector(`[data-scraper-id="${scraperId}"]`);
    if (!scraperCard) {
        // Buffer the stats for later replay
        pendingStats[scraperId] = stats;
        return;
    }

    // Update articles processed
    const articlesEl = scraperCard.querySelector('.stat-articles');
    if (articlesEl) {
        const currentValue = parseInt(articlesEl.textContent) || 0;
        const newValue = stats.articlesProcessed || 0;
        if (currentValue !== newValue) {
            articlesEl.textContent = newValue;
            // Flash effect to show update
            articlesEl.style.transition = 'color 0.3s';
            articlesEl.style.color = '#10b981';
            setTimeout(() => {
                articlesEl.style.color = '';
            }, 500);
        }
    }

    // Update errors
    const errorsEl = scraperCard.querySelector('.stat-errors');
    if (errorsEl) {
        errorsEl.textContent = stats.errors || 0;
    }

    // Update uptime
    const uptimeEl = scraperCard.querySelector('.stat-uptime');
    if (uptimeEl && stats.startTime) {
        const startTime = new Date(stats.startTime);
        const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
        uptimeEl.textContent = formatUptime(uptime);
    }

    // Update total errors count in dashboard
    updateTotalErrorsCount();

    // Clear buffer for this scraper
    delete pendingStats[scraperId];
}

// Recalculate and update total errors count
function updateTotalErrorsCount() {
    let totalErrors = 0;
    document.querySelectorAll('.stat-errors').forEach(errorsEl => {
        const count = parseInt(errorsEl.textContent) || 0;
        totalErrors += count;
    });
    totalErrorsEl.textContent = totalErrors;
}

// Update scraper current status (finding/extracting/waiting)
function updateScraperCurrentStatus(scraperId, currentStatus) {
    console.log('🎯 === UPDATE STATUS FUNCTION START ===');
    console.log('ScraperId:', scraperId);
    console.log('CurrentStatus:', currentStatus);
    
    const scraperCard = document.querySelector(`.scraper-card[data-scraper-id="${scraperId}"]`);
    console.log('Scraper card found:', !!scraperCard);
    if (!scraperCard) {
        console.error('❌ Scraper card NOT found for:', scraperId);
        console.log('Available cards:', Array.from(document.querySelectorAll('.scraper-card')).map(c => c.dataset.scraperId));
        return;
    }
    
    console.log('Card HTML:', scraperCard.outerHTML.substring(0, 500));
    
    const scraperBody = scraperCard.querySelector('.scraper-body');
    console.log('Scraper body found:', !!scraperBody);
    console.log('All elements with class scraper-body:', document.querySelectorAll('.scraper-body').length);
    
    if (!scraperBody) {
        console.error('❌ Scraper body NOT found');
        console.error('Card structure:', scraperCard.innerHTML.substring(0, 300));
        return;
    }
    
    // Remove existing status element
    let oldStatusEl = scraperBody.querySelector('.current-status');
    if (oldStatusEl) {
        console.log('Removing old status element');
        oldStatusEl.remove();
    }
    
    // Create new status element
    console.log('Creating new status element...');
    const statusEl = document.createElement('div');
    statusEl.className = 'current-status';
    console.log('Element created with class:', statusEl.className);
    
    const { state, details } = currentStatus;
    console.log('State:', state, 'Details:', details);
    
    let icon = '⚙️';
    let text = 'Processing';
    let progressHtml = '';
    
    if (state === 'finding') {
        icon = '🔍';
        text = details ? details : 'Finding articles';
    } else if (state === 'extracting') {
        icon = '📥';
        text = details;
    } else if (state === 'waiting') {
        icon = '⏳';
        const seconds = parseInt(details);
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        text = `${minutes}m ${secs}s`;
    }
    
    console.log('Icon:', icon, 'Text:', text);
    console.log('Has progress:', progressHtml.length > 0);
    
    statusEl.innerHTML = `
        <span class="status-icon">${icon}</span>
        <span class="status-text">${text}</span>
        ${progressHtml}
    `;
    
    console.log('HTML set, innerHTML length:', statusEl.innerHTML.length);
    
    // Insert at the beginning of scraper body
    console.log('Inserting element into scraper body...');
    scraperBody.insertBefore(statusEl, scraperBody.firstChild);
    
    console.log('Element inserted!');
    console.log('Element in DOM:', document.contains(statusEl));
    console.log('Element visible:', statusEl.offsetHeight > 0, 'height:', statusEl.offsetHeight);
    console.log('Element computed display:', window.getComputedStyle(statusEl).display);
    console.log('Element computed visibility:', window.getComputedStyle(statusEl).visibility);
    console.log('=== UPDATE STATUS FUNCTION END ===');
}

// Load scrapers data
async function loadScrapers() {
    try {
        const response = await fetch('/api/scrapers');
        const scrapers = await response.json();
        updateDashboard(scrapers);
        updateRunningSidebar(scrapers);
    } catch (error) {
        console.error('Error loading scrapers:', error);
        showNotification('Failed to load scrapers', 'error');
    }
}

// Update dashboard with scrapers data
function updateDashboard(scrapers) {
    console.log('updateDashboard called with scrapers:', scrapers);
    const scraperIds = Object.keys(scrapers);
    console.log('Scraper IDs:', scraperIds);
    const total = scraperIds.length;
    const running = scraperIds.filter(id => scrapers[id].status === 'running').length;
    const stopped = scraperIds.filter(id => scrapers[id].status === 'stopped').length;
    const totalErrors = scraperIds.reduce((sum, id) => sum + (scrapers[id].stats.errors || 0), 0);
    console.log('Stats - Total:', total, 'Running:', running, 'Stopped:', stopped);
    // Update stats
    totalScrapersEl.textContent = total;
    runningScrapersEl.textContent = running;
    stoppedScrapersEl.textContent = stopped;
    totalErrorsEl.textContent = totalErrors;
    console.log('Container element:', scrapersContainer);
    // Update or create scraper cards (preserving existing status displays)
    scraperIds.forEach(scraperId => {
        const scraper = scrapers[scraperId];
        console.log(`📊 Dashboard update for ${scraperId}: articles=${scraper.stats.articlesProcessed}, errors=${scraper.stats.errors}, status=${scraper.status}`);
        let card = document.querySelector(`[data-scraper-id="${scraperId}"]`);
        console.log(`Processing ${scraperId}, card exists:`, !!card);
        if (!card) {
            // Create new card if it doesn't exist
            console.log(`Creating new card for ${scraperId}`);
            card = createScraperCard(scraperId, scraper);
            scrapersContainer.appendChild(card);
            console.log(`Card created and appended for ${scraperId}`);
        } else {
            // Update existing card without removing status display
            console.log(`Updating existing card for ${scraperId}`);
            updateScraperCard(card, scraperId, scraper);
        }
        // After card is created/updated, replay any buffered stats
        if (pendingStats[scraperId]) {
            console.log(`🔁 Replaying buffered stats for ${scraperId}`);
            updateScraperStats(scraperId, pendingStats[scraperId]);
        }
    });
    // Remove cards for scrapers that no longer exist
    const existingCards = document.querySelectorAll('.scraper-card');
    existingCards.forEach(card => {
        const cardId = card.getAttribute('data-scraper-id');
        if (!scraperIds.includes(cardId)) {
            card.remove();
        }
    });
    console.log('Dashboard update complete');
}

// Create scraper card
function createScraperCard(scraperId, scraper) {
    const card = document.createElement('div');
    card.className = 'scraper-card';
    card.setAttribute('data-scraper-id', scraperId);
    
    const statusClass = `status-${scraper.status}`;
    const isRunning = scraper.status === 'running';
    
    // Format uptime
    const uptime = formatUptime(scraper.stats.uptime || 0);
    
    // Format last run
    const lastRun = scraper.lastRun || 'Never';
    
    // Determine logo based on scraper logo property or ID
    let logoHTML = '';
    if (scraper.logo) {
        // Use logo property from server config
        if (scraper.logo === 'bdnews') {
            logoHTML = '<img src="bdnews24-logo.png" alt="BDNews24" class="scraper-logo" onerror="console.error(\'Failed to load bdnews24-logo.png\')">';
        } else if (scraper.logo === 'palo-bangla') {
            logoHTML = '<img src="palo-bangla.svg" alt="Prothom Alo" class="scraper-logo" onerror="console.error(\'Failed to load palo-bangla.svg\')">';
        } else if (scraper.logo === 'kalbelalogo') {
            logoHTML = '<img src="kalbelalogo.png" alt="Kalbela" class="scraper-logo" onerror="console.error(\'Failed to load kalbelalogo.png\')">';
        } else if (scraper.logo === 'deshtvlogo') {
            logoHTML = '<img src="deshtvlogo.png" alt="Desh TV" class="scraper-logo" onerror="console.error(\'Failed to load deshtvlogo.png\')">';
        } else if (scraper.logo === 'dhakapost') {
            logoHTML = '<img src="dhakapost-logo.png" alt="DhakaPost" class="scraper-logo" onerror="console.error(\'Failed to load dhakapost-logo.png\')">';
        } else if (scraper.logo === 'jagonews24') {
            logoHTML = '<img src="jagonews24logo.png" alt="Jagonews24" class="scraper-logo" onerror="console.error(\'Failed to load jagonews24logo.png\')">';
        } else if (scraper.logo === 'samakal') {
            logoHTML = '<img src="samakallogo.png" alt="Samakal" class="scraper-logo" onerror="console.error(\'Failed to load samakallogo.png\')">';
        } else if (scraper.logo === 'sangbad') {
            logoHTML = '<img src="sangbadlogo.png" alt="Sangbad" class="scraper-logo" onerror="console.error(\'Failed to load sangbadlogo.png\')">';
        } else if (scraper.logo === 'amadershomoy') {
            logoHTML = '<img src="amadershomoylogo.png" alt="AmaderShomoy" class="scraper-logo" onerror="console.error(\'Failed to load amadershomoylogo.png\')">';
        } else if (scraper.logo === 'bdpratidin') {
            logoHTML = '<img src="bdpratidinlogo.png" alt="BD Pratidin" class="scraper-logo" onerror="console.error(\'Failed to load bdpratidinlogo.png\')">';
        } else if (scraper.logo === 'mzamin') {
            logoHTML = '<img src="mzaminlogo.png" alt="Mzamin" class="scraper-logo" onerror="console.error(\'Failed to load mzaminlogo.png\')">';
        } else if (scraper.logo === 'dhakatribune') {
            logoHTML = '<img src="dhakatribunelogo.png" alt="Dhaka Tribune" class="scraper-logo" onerror="console.error(\'Failed to load dhakatribunelogo.png\')">';
        } else if (scraper.logo === 'janakantha') {
            logoHTML = '<img src="janakanthalogo.png" alt="Janakantha" class="scraper-logo" onerror="console.error(\'Failed to load janakanthalogo.png\')">';
        } else if (scraper.logo === 'boishakhi') {
            logoHTML = '<img src="boishakhilogo.png" alt="Boishakhi" class="scraper-logo" onerror="console.error(\'Failed to load boishakhilogo.png\')">'; 
        }
    } else {
        // Fallback to scraper ID for backward compatibility
        if (scraperId === 'ittefaq') {
            logoHTML = '<img src="logo.svg" alt="Ittefaq" class="scraper-logo" onerror="console.error(\'Failed to load logo.svg\')">';
        } else if (scraperId === 'jugantor') {
            logoHTML = '<img src="jugantorlogo.png" alt="Jugantor" class="scraper-logo" onerror="console.error(\'Failed to load jugantorlogo.png\')">';
        } else if (scraperId === 'kalbela-desh') {
            logoHTML = '<img src="kalbelalogo.png" alt="Kalbela" class="scraper-logo" onerror="console.error(\'Failed to load kalbelalogo.png\')"><img src="deshtvlogo.png" alt="Desh TV" class="scraper-logo" onerror="console.error(\'Failed to load deshtvlogo.png\')">';
        }
    }
    
    console.log('Scraper ID:', scraperId, 'Logo:', scraper.logo, 'Logo HTML:', logoHTML);
    
    card.innerHTML = `
        <div class="scraper-header">
            <div class="scraper-name">
                ${logoHTML || '<h3>' + scraper.name + '</h3>'}
            </div>
            <div class="header-right">
                <button class="btn-icon" onclick="showCategories('${scraperId}', '${scraper.name}')" title="View Categories">
                    <span class="icon-info">ℹ️</span>
                </button>
                <span class="status-badge ${statusClass}">${scraper.status}</span>
            </div>
        </div>
        <div class="scraper-body">
            <div class="scraper-info">
                <div class="info-row">
                    <span class="info-label">Last Run:</span>
                    <span class="info-value">${lastRun}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Articles Processed:</span>
                    <span class="info-value stat-articles">${scraper.stats.articlesProcessed}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Errors:</span>
                    <span class="info-value stat-errors">${scraper.stats.errors}</span>
                </div>
                ${isRunning ? `
                <div class="info-row">
                    <span class="info-label">Uptime:</span>
                    <span class="info-value stat-uptime">${uptime}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">PID:</span>
                    <span class="info-value">${scraper.pid || 'N/A'}</span>
                </div>
                ` : ''}
            </div>
            <div class="scraper-actions">
                ${isRunning ? `
                    <button class="btn btn-danger" onclick="stopScraper('${scraperId}')">Stop</button>
                    <button class="btn btn-warning" onclick="restartScraper('${scraperId}')">Restart</button>
                ` : `
                    <button class="btn btn-success" onclick="startScraper('${scraperId}')">Start</button>
                `}
                <button class="btn btn-info" onclick="showOutput('${scraperId}', '${scraper.name}')">View Logs</button>
            </div>
            <div class="scraper-footer">
                <span class="autorun-label">Auto-repeat</span>
                <label class="autorun-switch">
                    <input type="checkbox" id="autorun-${scraperId}"
                           ${scraper.autorun !== 0 ? 'checked' : ''}
                           onchange="toggleAutorun('${scraperId}', this)">
                    <span class="autorun-slider"></span>
                </label>
            </div>
        </div>
    `;
    
    return card;
}

// Update existing scraper card without removing status display
function updateScraperCard(card, scraperId, scraper) {
    const statusClass = `status-${scraper.status}`;
    const isRunning = scraper.status === 'running';
    
    // Update status badge
    const statusBadge = card.querySelector('.status-badge');
    if (statusBadge) {
        statusBadge.className = `status-badge ${statusClass}`;
        statusBadge.textContent = scraper.status;
    }
    
    // Update individual stat values without destroying the DOM structure
    const scraperInfo = card.querySelector('.scraper-info');
    if (scraperInfo) {
        // Update last run
        const lastRunValue = scraperInfo.querySelector('.info-row:nth-child(1) .info-value');
        if (lastRunValue) {
            lastRunValue.textContent = scraper.lastRun || 'Never';
        }
        
        // Update articles processed
        const articlesValue = scraperInfo.querySelector('.stat-articles');
        if (articlesValue) {
            console.log(`📊 updateScraperCard: Setting ${scraperId} articles to ${scraper.stats.articlesProcessed}`);
            articlesValue.textContent = scraper.stats.articlesProcessed;
        }
        
        // Update errors
        const errorsValue = scraperInfo.querySelector('.stat-errors');
        if (errorsValue) {
            console.log(`📊 updateScraperCard: Setting ${scraperId} errors to ${scraper.stats.errors}`);
            errorsValue.textContent = scraper.stats.errors;
        }
        
        // Handle uptime and PID rows for running scrapers
        let uptimeRow = scraperInfo.querySelector('.info-row:nth-child(4)');
        let pidRow = scraperInfo.querySelector('.info-row:nth-child(5)');
        
        if (isRunning) {
            const uptime = formatUptime(scraper.stats.uptime || 0);
            
            // Add or update uptime row
            if (!uptimeRow || !uptimeRow.querySelector('.info-label')?.textContent.includes('Uptime')) {
                uptimeRow = document.createElement('div');
                uptimeRow.className = 'info-row';
                uptimeRow.innerHTML = `
                    <span class="info-label">Uptime:</span>
                    <span class="info-value stat-uptime">${uptime}</span>
                `;
                scraperInfo.appendChild(uptimeRow);
            } else {
                const uptimeValue = uptimeRow.querySelector('.stat-uptime');
                if (uptimeValue) uptimeValue.textContent = uptime;
            }
            
            // Add or update PID row
            if (!pidRow || !pidRow.querySelector('.info-label')?.textContent.includes('PID')) {
                pidRow = document.createElement('div');
                pidRow.className = 'info-row';
                pidRow.innerHTML = `
                    <span class="info-label">PID:</span>
                    <span class="info-value">${scraper.pid || 'N/A'}</span>
                `;
                scraperInfo.appendChild(pidRow);
            } else {
                const pidValue = pidRow.querySelector('.info-value:last-child');
                if (pidValue) pidValue.textContent = scraper.pid || 'N/A';
            }
        } else {
            // Remove uptime and PID rows for stopped scrapers
            const allRows = scraperInfo.querySelectorAll('.info-row');
            allRows.forEach(row => {
                const label = row.querySelector('.info-label');
                if (label && (label.textContent.includes('Uptime') || label.textContent.includes('PID'))) {
                    row.remove();
                }
            });
        }
    }
    
    // Update action buttons
    const actionsContainer = card.querySelector('.scraper-actions');
    if (actionsContainer) {
        actionsContainer.innerHTML = `
            ${isRunning ? `
                <button class="btn btn-danger" onclick="stopScraper('${scraperId}')">Stop</button>
                <button class="btn btn-warning" onclick="restartScraper('${scraperId}')">Restart</button>
            ` : `
                <button class="btn btn-success" onclick="startScraper('${scraperId}')">Start</button>
            `}
            <button class="btn btn-info" onclick="showOutput('${scraperId}', '${scraper.name}')">View Logs</button>
        `;
    }

    // Update autorun toggle (only if scraper object has explicit autorun field)
    if (scraper.autorun !== undefined) {
        const autorunCheckbox = card.querySelector(`#autorun-${scraperId}`);
        if (autorunCheckbox) {
            autorunCheckbox.checked = scraper.autorun !== 0;
        }
    }
}

// Format uptime
function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
}

// Toggle autorun on/off for a scraper
async function toggleAutorun(scraperId, checkbox) {
    const newValue = checkbox.checked ? 1 : 0;
    try {
        const response = await fetch(`/api/autorun/${scraperId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autorun: newValue })
        });
        if (!response.ok) throw new Error('Server error');
        showNotification(
            `Auto-repeat ${newValue ? 'enabled' : 'disabled'} for ${scraperId}`,
            newValue ? 'success' : 'warning'
        );
    } catch (error) {
        console.error('Error toggling autorun:', error);
        checkbox.checked = !checkbox.checked; // revert on failure
        showNotification('Failed to update auto-repeat setting', 'error');
    }
}

// Start scraper
async function startScraper(scraperId) {
    try {
        const response = await fetch(`/api/scrapers/${scraperId}/start`, {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showNotification(`Scraper started successfully`, 'success');
        } else {
            showNotification(`Failed to start scraper: ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error starting scraper:', error);
        showNotification('Failed to start scraper', 'error');
    }
}

// Stop scraper
async function stopScraper(scraperId) {
    try {
        // Immediately update UI to show stopping state
        const card = document.querySelector(`[data-scraper-id="${scraperId}"]`);
        if (card) {
            const statusBadge = card.querySelector('.status-badge');
            if (statusBadge) {
                statusBadge.className = 'status-badge status-stopped';
                statusBadge.textContent = 'stopped';
            }
            
            // Remove status display immediately
            const statusDisplay = card.querySelector('.current-status');
            if (statusDisplay) {
                statusDisplay.remove();
            }
        }
        
        const response = await fetch(`/api/scrapers/${scraperId}/stop`, {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showNotification(`Scraper stopped successfully`, 'success');
            // Don't reload - socket will handle status update
        } else {
            showNotification(`Failed to stop scraper: ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error stopping scraper:', error);
        showNotification('Failed to stop scraper', 'error');
    }
}

// Restart scraper
async function restartScraper(scraperId) {
    try {
        const response = await fetch(`/api/scrapers/${scraperId}/restart`, {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showNotification(`Scraper restarting...`, 'success');
        } else {
            showNotification(`Failed to restart scraper: ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error restarting scraper:', error);
        showNotification('Failed to restart scraper', 'error');
    }
}

// Show output modal
async function showOutput(scraperId, scraperName) {
    currentScraperId = scraperId;
    modalTitle.textContent = `${scraperName} - Output Logs`;
    
    // Load output from server
    try {
        const response = await fetch(`/api/scrapers/${scraperId}/output`);
        const data = await response.json();
        
        if (!outputBuffer[scraperId]) {
            outputBuffer[scraperId] = data.output || [];
        }
        
        displayOutput(scraperId);
        outputModal.style.display = 'block';
    } catch (error) {
        console.error('Error loading output:', error);
        showNotification('Failed to load output logs', 'error');
    }
}

// Display output in modal
function displayOutput(scraperId) {
    const buffer = outputBuffer[scraperId] || [];
    
    outputLogs.innerHTML = '';
    
    if (buffer.length === 0) {
        outputLogs.innerHTML = '<div style="color: #858585;">No output yet...</div>';
        return;
    }
    
    buffer.forEach(entry => {
        const logClass = entry.type === 'stderr' ? 'log-stderr' : 'log-stdout';
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${logClass}`;
        logEntry.innerHTML = `<span class="log-timestamp">${timestamp}</span>${escapeHtml(entry.message)}`;
        
        outputLogs.appendChild(logEntry);
    });
    
    // Scroll to bottom
    outputLogs.scrollTop = outputLogs.scrollHeight;
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show categories modal
async function showCategories(scraperId, scraperName) {
    currentCategoriesScraperId = scraperId;
    categoriesModalTitle.textContent = `${scraperName} - Categories`;

    try {
        const response = await fetch(`/api/scrapers/${scraperId}`);
        const scraper = await response.json();

        displayCategories(scraper.categories || {}, scraper.status, scraper.categoryStatus || {});
        categoriesModal.style.display = 'block';
    } catch (error) {
        console.error('Error loading categories:', error);
        showNotification('Failed to load categories', 'error');
    }
}

// Display categories in table
function displayCategories(categories, scraperStatus, categoryStatus) {
    categoriesTbody.innerHTML = '';

    if (Object.keys(categories).length === 0) {
        categoriesTbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No categories found</td></tr>';
        return;
    }

    const isRunning = scraperStatus === 'running';

    if (isRunning) {
        const warningRow = document.createElement('tr');
        warningRow.innerHTML = '<td colspan="4" style="background: #fef3c7; color: #92400e; padding: 10px; text-align: center; font-weight: 600;">⚠️ Scraper is running. Stop the scraper to edit categories.</td>';
        categoriesTbody.appendChild(warningRow);
    }

    Object.entries(categories).forEach(([category, datetime]) => {
        const isEnabled = categoryStatus[category];
        const statusBadge = isEnabled
            ? '<span class="status-badge status-enabled">✓ Enabled</span>'
            : '<span class="status-badge status-disabled">✗ Disabled</span>';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${category}</td>
            <td>${statusBadge}</td>
            <td>
                <input type="datetime-local"
                       class="datetime-input"
                       value="${formatDatetimeForInput(datetime)}"
                       data-category="${category}"
                       ${isRunning ? 'disabled' : ''}>
            </td>
            <td>
                <button class="btn btn-primary btn-sm ${isRunning ? 'btn-disabled' : ''}"
                        data-category="${category}"
                        ${isRunning ? 'disabled' : ''}>
                    Save
                </button>
            </td>
        `;
        categoriesTbody.appendChild(row);

        // Add event listener to the save button
        const saveBtn = row.querySelector('button');
        if (saveBtn && !isRunning) {
            saveBtn.addEventListener('click', () => saveCategory(category));
        }
    });
}

// Format datetime string for input field
function formatDatetimeForInput(datetimeStr) {
    try {
        // Convert "2026-01-24 00:29:58" to "2026-01-24T00:29"
        const date = new Date(datetimeStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    } catch (e) {
        console.error('Error formatting datetime:', e);
        return '';
    }
}

// Save category datetime
async function saveCategory(category) {
    console.log('saveCategory called with:', category);
    console.log('currentCategoriesScraperId:', currentCategoriesScraperId);
    
    if (!currentCategoriesScraperId) {
        console.error('No currentCategoriesScraperId');
        return;
    }
    
    const input = document.querySelector(`input[data-category="${category}"]`);
    console.log('Input found:', input);
    
    if (!input) {
        console.error('Input not found for category:', category);
        return;
    }
    
    // Check if input is disabled (scraper running)
    if (input.disabled) {
        console.log('Input is disabled');
        showNotification('Cannot save while scraper is running', 'error');
        return;
    }
    
    const newDatetime = input.value;
    console.log('New datetime value:', newDatetime);
    
    if (!newDatetime) {
        showNotification('Please enter a valid date and time', 'error');
        return;
    }
    
    // Convert from "2026-01-24T00:29" to "2026-01-24 00:29:00"
    const formattedDatetime = newDatetime.replace('T', ' ') + ':00';
    console.log('Formatted datetime:', formattedDatetime);
    console.log('Sending PUT request to:', `/api/scrapers/${currentCategoriesScraperId}/category`);
    
    try {
        const response = await fetch(`/api/scrapers/${currentCategoriesScraperId}/category`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                category: category,
                datetime: formattedDatetime
            })
        });
        
        console.log('Response status:', response.status);
        
        if (response.ok) {
            showNotification(`Updated ${category} to ${formattedDatetime}`, 'success');
            // Refresh the categories display
            const scraperResponse = await fetch(`/api/scrapers/${currentCategoriesScraperId}`);
            const scraper = await scraperResponse.json();
            displayCategories(scraper.categories || {}, scraper.status, scraper.categoryStatus || {});
        } else {
            const error = await response.json();
            console.error('Error response:', error);
            showNotification(error.error || 'Failed to update category', 'error');
        }
    } catch (error) {
        console.error('Error saving category:', error);
        showNotification('Failed to update category', 'error');
    }
}

// Close modal
closeModal.onclick = function() {
    outputModal.style.display = 'none';
    currentScraperId = null;
};

// Close categories modal
closeCategoriesModal.onclick = function() {
    categoriesModal.style.display = 'none';
    currentCategoriesScraperId = null;
};

window.onclick = function(event) {
    if (event.target === outputModal) {
        outputModal.style.display = 'none';
        currentScraperId = null;
    }
    if (event.target === categoriesModal) {
        categoriesModal.style.display = 'none';
        currentCategoriesScraperId = null;
    }
};

// Start all scrapers
startAllBtn.onclick = async function() {
    try {
        const response = await fetch('/api/scrapers/start-all', {
            method: 'POST'
        });
        const results = await response.json();
        
        showNotification('Starting all scrapers...', 'success');
    } catch (error) {
        console.error('Error starting all scrapers:', error);
        showNotification('Failed to start all scrapers', 'error');
    }
};

// Stop all scrapers
stopAllBtn.onclick = async function() {
    try {
        const response = await fetch('/api/scrapers/stop-all', {
            method: 'POST'
        });
        const results = await response.json();
        
        showNotification('Stopping all scrapers...', 'success');
    } catch (error) {
        console.error('Error stopping all scrapers:', error);
        showNotification('Failed to stop all scrapers', 'error');
    }
};

// Update running sidebar
// Update sidebar status for a scraper
function updateSidebarStatus(scraperId, currentStatus) {
    const sidebarItem = document.querySelector(`.sidebar-item[data-scraper-id="${scraperId}"]`);
    if (!sidebarItem) {
        console.log('Sidebar item not found for:', scraperId);
        return;
    }
    
    const statusContainer = sidebarItem.querySelector('.sidebar-status-container');
    if (!statusContainer) {
        console.log('Status container not found in sidebar item');
        return;
    }
    
    const { state, details } = currentStatus;
    let icon = '⚙️';
    let text = 'Processing';
    
    if (state === 'finding') {
        icon = '🔍';
        text = details ? details : 'Finding articles';
    } else if (state === 'extracting') {
        icon = '📥';
        text = details;
    } else if (state === 'waiting') {
        icon = '⏳';
        const seconds = parseInt(details);
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        text = `${minutes}m ${secs}s`;
    }
    
    statusContainer.innerHTML = `
        <div class="sidebar-status">
            <span class="sidebar-status-icon">${icon}</span>
            <span class="sidebar-status-text">${text}</span>
        </div>
    `;
}

async function updateRunningSidebar(scrapers) {
    // Check if sidebar elements exist
    if (!sidebarList || !sidebarRunningCount) {
        console.log('Sidebar elements not found');
        return;
    }
    
    if (!scrapers) {
        try {
            const response = await fetch('/api/scrapers');
            scrapers = await response.json();
        } catch (error) {
            console.error('Error loading scrapers for sidebar:', error);
            return;
        }
    }
    
    const scraperIds = Object.keys(scrapers);
    const runningScrapers = scraperIds.filter(id => scrapers[id].status === 'running');
    
    console.log('Updating sidebar with', runningScrapers.length, 'running scrapers');
    
    // Update count
    sidebarRunningCount.textContent = runningScrapers.length;
    
    // Clear list
    sidebarList.innerHTML = '';
    
    if (runningScrapers.length === 0) {
        sidebarList.innerHTML = '<div class="sidebar-empty">No running scrapers</div>';
        return;
    }
    
    // Add running scrapers
    runningScrapers.forEach(scraperId => {
        const scraper = scrapers[scraperId];
        const item = document.createElement('div');
        item.className = 'sidebar-item';
        item.setAttribute('data-scraper-id', scraperId);
        
        const uptime = formatUptime(scraper.stats.uptime || 0);
        
        item.innerHTML = `
            <span class="sidebar-item-name">${scraper.name}</span>
            <div class="sidebar-status-container"></div>
            <div class="sidebar-item-info">
                <span class="sidebar-item-uptime">⏱️ ${uptime}</span>
                <span class="sidebar-item-articles">📰 ${scraper.stats.articlesProcessed}</span>
            </div>
            <button class="sidebar-stop-btn" data-scraper-id="${scraperId}">
                Stop
            </button>
        `;
        
        sidebarList.appendChild(item);
        
        // Add stop button listener
        const stopBtn = item.querySelector('.sidebar-stop-btn');
        stopBtn.addEventListener('click', async function(e) {
            e.stopPropagation();
            await stopScraper(scraperId);
        });
    });
}

// Show notification
function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Create toast notification
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Show toast
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Initial load
loadScrapers();

// Test function to manually add status to first scraper card (for debugging)
window.testStatus = function() {
    const firstCard = document.querySelector('.scraper-card');
    if (!firstCard) {
        console.log('No scraper card found');
        return;
    }
    const scraperId = firstCard.getAttribute('data-scraper-id');
    console.log('Testing status on:', scraperId);
    updateScraperCurrentStatus(scraperId, {
        state: 'extracting',
        details: '5/10'
    });
};

// Auto-update stats every 2 seconds for running scrapers (real-time article counts)
setInterval(async () => {
    try {
        const response = await fetch('/api/scrapers');
        const scrapers = await response.json();

        Object.keys(scrapers).forEach(scraperId => {
            const scraper = scrapers[scraperId];
            if (scraper.status !== 'running') return;

            // Update scraper card
            const card = document.querySelector(`.scraper-card[data-scraper-id="${scraperId}"]`);
            if (card) {
                // Update uptime
                const uptimeEl = card.querySelector('.stat-uptime');
                if (uptimeEl && scraper.stats.uptime) {
                    uptimeEl.textContent = formatUptime(scraper.stats.uptime);
                }

                // Update article count with flash effect
                const articlesEl = card.querySelector('.stat-articles');
                if (articlesEl) {
                    const currentValue = parseInt(articlesEl.textContent) || 0;
                    const newValue = scraper.stats.articlesProcessed || 0;
                    if (currentValue !== newValue) {
                        articlesEl.textContent = newValue;
                        articlesEl.style.transition = 'color 0.3s';
                        articlesEl.style.color = '#10b981';
                        setTimeout(() => { articlesEl.style.color = ''; }, 500);
                    }
                }

                // Update errors
                const errorsEl = card.querySelector('.stat-errors');
                if (errorsEl) {
                    errorsEl.textContent = scraper.stats.errors || 0;
                }
            }

            // Update sidebar item
            const sidebarItem = document.querySelector(`.sidebar-item[data-scraper-id="${scraperId}"]`);
            if (sidebarItem) {
                const uptimeEl = sidebarItem.querySelector('.sidebar-item-uptime');
                if (uptimeEl && scraper.stats.uptime) {
                    uptimeEl.innerHTML = `⏱️ ${formatUptime(scraper.stats.uptime)}`;
                }
                const articlesEl = sidebarItem.querySelector('.sidebar-item-articles');
                if (articlesEl) {
                    articlesEl.innerHTML = `📰 ${scraper.stats.articlesProcessed}`;
                }
            }
        });
    } catch (err) {
        // Silently ignore fetch errors
    }
}, 2000);
