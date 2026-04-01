// Connect to Socket.IO
const socket = io();

// DOM elements
const lastrunTbody = document.getElementById('lastrun-tbody');
const searchInput = document.getElementById('search-input');
const scraperFilter = document.getElementById('scraper-filter');

let allData = [];
let scrapers = {};

// Load data on connect
socket.on('connect', () => {
    console.log('Connected to server');
    loadData();
});

// Load all scrapers and their categories
async function loadData() {
    try {
        const response = await fetch('/api/scrapers');
        scrapers = await response.json();
        
        // Build data array
        allData = [];
        Object.keys(scrapers).forEach(scraperId => {
            const scraper = scrapers[scraperId];
            
            if (scraper.categories && Object.keys(scraper.categories).length > 0) {
                Object.entries(scraper.categories).forEach(([category, datetime]) => {
                    allData.push({
                        scraperId,
                        scraperName: scraper.name,
                        category,
                        datetime,
                        status: scraper.status
                    });
                });
            }
        });
        
        // Populate scraper filter
        populateScraperFilter();
        
        // Display data
        displayData(allData);
        
    } catch (error) {
        console.error('Error loading data:', error);
        lastrunTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ef4444;">Failed to load data</td></tr>';
    }
}

// Populate scraper filter dropdown
function populateScraperFilter() {
    const scraperIds = [...new Set(allData.map(d => d.scraperId))];
    
    scraperFilter.innerHTML = '<option value="">All Scrapers</option>';
    scraperIds.forEach(id => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = scrapers[id].name;
        scraperFilter.appendChild(option);
    });
}

// Display data in table
function displayData(data) {
    lastrunTbody.innerHTML = '';
    
    if (data.length === 0) {
        lastrunTbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No data found</td></tr>';
        return;
    }
    
    data.forEach(item => {
        const row = document.createElement('tr');
        const isRunning = item.status === 'running';
        
        row.innerHTML = `
            <td><strong>${item.scraperName}</strong></td>
            <td>${item.category}</td>
            <td>
                <input type="datetime-local" 
                       class="datetime-input-table" 
                       value="${formatDatetimeForInput(item.datetime)}" 
                       data-scraper="${item.scraperId}"
                       data-category="${item.category}"
                       ${isRunning ? 'disabled' : ''}>
            </td>
            <td>
                <span class="status-badge-small status-${item.status}">${item.status}</span>
            </td>
            <td>
                <button class="btn btn-primary btn-sm ${isRunning ? 'btn-disabled' : ''}" 
                        data-scraper="${item.scraperId}"
                        data-category="${item.category}"
                        ${isRunning ? 'disabled' : ''}>
                    Save
                </button>
            </td>
        `;
        
        lastrunTbody.appendChild(row);
        
        // Add event listener to save button
        const saveBtn = row.querySelector('button');
        if (saveBtn && !isRunning) {
            saveBtn.addEventListener('click', () => saveLastRun(item.scraperId, item.category));
        }
    });
}

// Format datetime for input
function formatDatetimeForInput(datetimeStr) {
    try {
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

// Save last run
async function saveLastRun(scraperId, category) {
    console.log('Saving last run for:', scraperId, category);
    
    const input = document.querySelector(`input[data-scraper="${scraperId}"][data-category="${category}"]`);
    if (!input) {
        console.error('Input not found');
        return;
    }
    
    if (input.disabled) {
        showNotification('Cannot update while scraper is running', 'error');
        return;
    }
    
    const newDatetime = input.value;
    if (!newDatetime) {
        showNotification('Please enter a valid date and time', 'error');
        return;
    }
    
    const formattedDatetime = newDatetime.replace('T', ' ') + ':00';
    console.log('Saving:', formattedDatetime);
    
    try {
        const response = await fetch(`/api/scrapers/${scraperId}/category`, {
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
            // Reload data
            await loadData();
        } else {
            const error = await response.json();
            console.error('Error:', error);
            showNotification(error.error || 'Failed to update', 'error');
        }
    } catch (error) {
        console.error('Error saving:', error);
        showNotification('Failed to update', 'error');
    }
}

// Filter data
function filterData() {
    const searchTerm = searchInput.value.toLowerCase();
    const selectedScraper = scraperFilter.value;
    
    let filtered = allData;
    
    // Filter by scraper
    if (selectedScraper) {
        filtered = filtered.filter(item => item.scraperId === selectedScraper);
    }
    
    // Filter by search term
    if (searchTerm) {
        filtered = filtered.filter(item => 
            item.scraperName.toLowerCase().includes(searchTerm) ||
            item.category.toLowerCase().includes(searchTerm)
        );
    }
    
    displayData(filtered);
}

// Event listeners
searchInput.addEventListener('input', filterData);
scraperFilter.addEventListener('change', filterData);

// Show notification
function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Listen for scraper status changes
socket.on('scraper-status', () => {
    loadData();
});

// Initial load
loadData();
