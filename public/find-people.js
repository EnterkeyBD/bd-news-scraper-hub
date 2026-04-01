// Find People - Face Search Logic

const socket = io();
let selectedFiles = []; // Changed from single file to array
let selectedFilesA = []; // Pair mode: person A files
let selectedFilesB = []; // Pair mode: person B files
let autoBuildThreshold = null; // Store auto-build threshold
let searchMode = 'person'; // 'person', 'relation', or 'pair'

// DOM elements
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadPlaceholder = document.getElementById('uploadPlaceholder');
const uploadPreviewGrid = document.getElementById('uploadPreviewGrid');
const searchBtn = document.getElementById('searchBtn');
const thresholdSlider = document.getElementById('threshold');
const thresholdValue = document.getElementById('thresholdValue');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const resultsSection = document.getElementById('resultsSection');
const resultsTitle = document.getElementById('resultsTitle');
const resultsGrid = document.getElementById('resultsGrid');
const emptyState = document.getElementById('emptyState');
const buildProgress = document.getElementById('buildProgress');
const buildLog = document.getElementById('buildLog');
const buildIndexBtn = document.getElementById('buildIndexBtn');
const autoBuildInput = document.getElementById('autoBuildThreshold');
const saveAutoBuildBtn = document.getElementById('saveAutoBuildBtn');
const disableAutoBuildBtn = document.getElementById('disableAutoBuildBtn');
const autoBuildStatus = document.getElementById('autoBuildStatus');

// Cluster threshold elements
const clusterThresholdSlider = document.getElementById('clusterThreshold');
const clusterThresholdValue = document.getElementById('clusterThresholdValue');
const clusterThresholdControl = document.getElementById('clusterThresholdControl');

// Mode toggle elements
const modePerson = document.getElementById('modePerson');
const modeRelation = document.getElementById('modeRelation');
const relationResultsSection = document.getElementById('relationResultsSection');
const relationResultsContainer = document.getElementById('relationResultsContainer');
const relationResultsTitle = document.getElementById('relationResultsTitle');
const uploadHint = document.getElementById('uploadHint');
const uploadHintSmall = document.getElementById('uploadHintSmall');

// Pair mode elements
const modePair = document.getElementById('modePair');
const uploadSectionSingle = document.getElementById('uploadSectionSingle');
const uploadSectionPair = document.getElementById('uploadSectionPair');
const uploadZoneA = document.getElementById('uploadZoneA');
const uploadZoneB = document.getElementById('uploadZoneB');
const fileInputA = document.getElementById('fileInputA');
const fileInputB = document.getElementById('fileInputB');
const uploadPlaceholderA = document.getElementById('uploadPlaceholderA');
const uploadPlaceholderB = document.getElementById('uploadPlaceholderB');
const uploadPreviewGridA = document.getElementById('uploadPreviewGridA');
const uploadPreviewGridB = document.getElementById('uploadPreviewGridB');
const pairSearchBtn = document.getElementById('pairSearchBtn');
const pairThresholdSlider = document.getElementById('pairThreshold');
const pairThresholdValue = document.getElementById('pairThresholdValue');
const pairResultsSection = document.getElementById('pairResultsSection');
const pairResultsTitle = document.getElementById('pairResultsTitle');
const pairResultsGrid = document.getElementById('pairResultsGrid');

// Init
loadAutoBuildThreshold();
loadIndexStatus();
restoreSearchState();

// Threshold sliders
thresholdSlider.addEventListener('input', () => {
    thresholdValue.textContent = parseFloat(thresholdSlider.value).toFixed(2);
});
clusterThresholdSlider.addEventListener('input', () => {
    clusterThresholdValue.textContent = parseFloat(clusterThresholdSlider.value).toFixed(2);
});
pairThresholdSlider.addEventListener('input', () => {
    pairThresholdValue.textContent = parseFloat(pairThresholdSlider.value).toFixed(2);
});

// Upload zone events
uploadZone.addEventListener('click', (e) => {
    if (e.target.closest('.btn-remove')) return;
    fileInput.click();
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) {
        handleFiles(files);
    }
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
        handleFiles(Array.from(fileInput.files));
    }
});

// Pair upload zone A events
uploadZoneA.addEventListener('click', (e) => {
    if (e.target.closest('.btn-remove-item')) return;
    fileInputA.click();
});
uploadZoneA.addEventListener('dragover', (e) => { e.preventDefault(); uploadZoneA.classList.add('drag-over'); });
uploadZoneA.addEventListener('dragleave', () => { uploadZoneA.classList.remove('drag-over'); });
uploadZoneA.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZoneA.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) handlePairFiles('a', files);
});
fileInputA.addEventListener('change', () => {
    if (fileInputA.files.length > 0) handlePairFiles('a', Array.from(fileInputA.files));
});

// Pair upload zone B events
uploadZoneB.addEventListener('click', (e) => {
    if (e.target.closest('.btn-remove-item')) return;
    fileInputB.click();
});
uploadZoneB.addEventListener('dragover', (e) => { e.preventDefault(); uploadZoneB.classList.add('drag-over'); });
uploadZoneB.addEventListener('dragleave', () => { uploadZoneB.classList.remove('drag-over'); });
uploadZoneB.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZoneB.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) handlePairFiles('b', files);
});
fileInputB.addEventListener('change', () => {
    if (fileInputB.files.length > 0) handlePairFiles('b', Array.from(fileInputB.files));
});

function handleFiles(files) {
    // Limit to 10 images
    if (files.length > 10) {
        alert('Maximum 10 images allowed. Only the first 10 will be used.');
        files = files.slice(0, 10);
    }

    selectedFiles = files;
    uploadPlaceholder.style.display = 'none';
    uploadPreviewGrid.style.display = 'grid';
    uploadPreviewGrid.innerHTML = '';

    files.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const previewItem = document.createElement('div');
            previewItem.className = 'preview-item';
            previewItem.innerHTML = `
                <img src="${e.target.result}" alt="Preview ${index + 1}">
                <button class="btn-remove-item" onclick="removeFile(${index})" title="Remove">&times;</button>
                <span class="image-number">${index + 1}</span>
            `;
            uploadPreviewGrid.appendChild(previewItem);
        };
        reader.readAsDataURL(file);
    });

    searchBtn.disabled = false;
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        clearUpload();
    } else {
        handleFiles(selectedFiles);
    }
}

function clearUpload() {
    selectedFiles = [];
    fileInput.value = '';
    uploadPlaceholder.style.display = '';
    uploadPreviewGrid.style.display = 'none';
    uploadPreviewGrid.innerHTML = '';
    searchBtn.disabled = true;
    resultsSection.style.display = 'none';
    emptyState.style.display = 'none';
    // Clear saved search state
    sessionStorage.removeItem('faceSearchResults');
}

function handlePairFiles(side, files) {
    if (files.length > 10) {
        alert('Maximum 10 images allowed. Only the first 10 will be used.');
        files = files.slice(0, 10);
    }

    if (side === 'a') {
        selectedFilesA = files;
        renderPairPreviews('a');
    } else {
        selectedFilesB = files;
        renderPairPreviews('b');
    }
    updatePairSearchBtn();
}

function renderPairPreviews(side) {
    const files = side === 'a' ? selectedFilesA : selectedFilesB;
    const placeholder = side === 'a' ? uploadPlaceholderA : uploadPlaceholderB;
    const grid = side === 'a' ? uploadPreviewGridA : uploadPreviewGridB;

    if (files.length === 0) {
        placeholder.style.display = '';
        grid.style.display = 'none';
        grid.innerHTML = '';
        return;
    }

    placeholder.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = '';

    files.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const item = document.createElement('div');
            item.className = 'preview-item';
            item.innerHTML = `
                <img src="${e.target.result}" alt="Preview ${index + 1}">
                <button class="btn-remove-item" onclick="removePairFile('${side}', ${index})" title="Remove">&times;</button>
                <span class="image-number">${index + 1}</span>
            `;
            grid.appendChild(item);
        };
        reader.readAsDataURL(file);
    });
}

function removePairFile(side, index) {
    if (side === 'a') {
        selectedFilesA.splice(index, 1);
        renderPairPreviews('a');
    } else {
        selectedFilesB.splice(index, 1);
        renderPairPreviews('b');
    }
    updatePairSearchBtn();
}

function updatePairSearchBtn() {
    pairSearchBtn.disabled = !(selectedFilesA.length > 0 && selectedFilesB.length > 0);
}

function clearResults() {
    resultsSection.style.display = 'none';
    resultsGrid.innerHTML = '';
    relationResultsSection.style.display = 'none';
    relationResultsContainer.innerHTML = '';
    pairResultsSection.style.display = 'none';
    pairResultsGrid.innerHTML = '';
    emptyState.style.display = 'none';
    sessionStorage.removeItem('faceSearchResults');
}

function setSearchMode(mode) {
    searchMode = mode;
    modePerson.classList.toggle('active', mode === 'person');
    modeRelation.classList.toggle('active', mode === 'relation');
    modePair.classList.toggle('active', mode === 'pair');

    // Toggle upload sections
    uploadSectionSingle.style.display = mode === 'pair' ? 'none' : '';
    uploadSectionPair.style.display = mode === 'pair' ? '' : 'none';

    // Update UI hints
    if (mode === 'relation') {
        searchBtn.textContent = 'Search Relations';
        uploadHint.textContent = 'Upload 1-10 photos of the target person';
        uploadHintSmall.textContent = 'Find people who frequently appear with this person';
        clusterThresholdControl.style.display = '';
    } else if (mode === 'person') {
        searchBtn.textContent = 'Search';
        uploadHint.textContent = 'Upload 1-10 clear face photos of the same person';
        uploadHintSmall.textContent = 'Multiple images improve accuracy by 15-25%';
        clusterThresholdControl.style.display = 'none';
    } else {
        clusterThresholdControl.style.display = 'none';
    }

    // Hide results from other mode
    clearResults();
}

async function searchFaces() {
    if (selectedFiles.length === 0) return;

    if (searchMode === 'relation') {
        return searchRelations();
    }

    // Show loading
    loadingOverlay.style.display = 'flex';
    const isMulti = selectedFiles.length > 1;
    loadingText.textContent = isMulti
        ? `Analyzing faces from ${selectedFiles.length} images...`
        : 'Analyzing faces...';
    resultsSection.style.display = 'none';
    emptyState.style.display = 'none';
    searchBtn.disabled = true;

    const formData = new FormData();
    const threshold = thresholdSlider.value;
    const limit = '30';

    // Choose endpoint based on number of files
    let endpoint;
    if (isMulti) {
        endpoint = '/api/face-search-multi';
        selectedFiles.forEach(file => {
            formData.append('images', file);
        });
        formData.append('strategy', 'hybrid'); // Use hybrid strategy by default
    } else {
        endpoint = '/api/face-search';
        formData.append('image', selectedFiles[0]);
    }

    formData.append('threshold', threshold);
    formData.append('limit', limit);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        loadingOverlay.style.display = 'none';
        searchBtn.disabled = false;

        if (!response.ok || data.error) {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = data.error || 'Search failed. Please try again.';
            return;
        }

        if (data.matches && data.matches.length > 0) {
            // Show info about multi-image search if applicable
            if (isMulti && data.images_processed) {
                resultsTitle.textContent = `Found ${data.matches.length} match${data.matches.length !== 1 ? 'es' : ''} (using ${data.images_processed} images)`;
            }
            // Save search state before rendering
            saveSearchState(data.matches, isMulti ? data.images_processed : 1);
            renderResults(data.matches);
        } else {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = 'No matching faces found. Try lowering the similarity threshold.';
            sessionStorage.removeItem('faceSearchResults');
        }
    } catch (err) {
        loadingOverlay.style.display = 'none';
        searchBtn.disabled = false;
        emptyState.style.display = 'block';
        document.getElementById('emptyText').textContent = 'Error: ' + err.message;
    }
}

function renderResults(matches) {
    resultsTitle.textContent = `Found ${matches.length} match${matches.length !== 1 ? 'es' : ''}`;
    resultsSection.style.display = 'block';
    resultsGrid.innerHTML = '';

    for (const match of matches) {
        const scorePercent = Math.round(match.score * 100);
        const scoreClass = scorePercent >= 70 ? 'score-high' : scorePercent >= 50 ? 'score-medium' : 'score-low';
        const sourceName = getSourceName(match.source_site);
        const sourceClass = getSourceClass(match.source_site);

        const card = document.createElement('div');
        card.className = 'result-card';
        card.innerHTML = `
            <div class="result-image-container">
                <img src="/news_images/${match.image}" alt="Match" class="result-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22><rect fill=%22%23ddd%22 width=%22200%22 height=%22150%22/><text fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22>No Image</text></svg>'">
                <span class="score-badge ${scoreClass}">${scorePercent}%</span>
            </div>
            <div class="result-info">
                ${match.headline ? `<p class="result-headline" title="${escapeHtml(match.headline)}">${escapeHtml(match.headline)}</p>` : '<p class="result-headline no-article">No linked article</p>'}
                <div class="result-meta">
                    ${match.source_site ? `<span class="source-badge source-${sourceClass}">${sourceName}</span>` : ''}
                    ${match.published_at ? `<span class="result-date">${formatDate(match.published_at)}</span>` : ''}
                </div>
                <a href="article-view.html?image=${encodeURIComponent(match.image)}" class="result-link">View Details</a>
            </div>
        `;

        // Add circle highlight on the matched face
        const cardImg = card.querySelector('.result-image');
        const bbox = match.bbox;
        if (bbox) {
            cardImg.addEventListener('load', function() {
                const [bx1, by1, bx2, by2] = bbox;
                const nw = this.naturalWidth;
                const nh = this.naturalHeight;
                const cx = (bx1 + bx2) / 2;
                const cy = (by1 + by2) / 2;
                // 35% padding around face for a generous circle
                const faceSize = Math.max(bx2 - bx1, by2 - by1);
                const r = faceSize * 0.68;
                const sw = Math.max(3, Math.round(r * 0.1));

                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('class', 'face-highlight-svg');
                svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
                svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', cx);
                circle.setAttribute('cy', cy);
                circle.setAttribute('r', r);
                circle.setAttribute('stroke', '#667eea');
                circle.setAttribute('stroke-width', sw);
                circle.setAttribute('fill', 'none');

                svg.appendChild(circle);
                this.parentElement.appendChild(svg);
            });
        }

        resultsGrid.appendChild(card);
    }
}

// Index management
async function loadIndexStatus() {
    try {
        const res = await fetch('/api/face-index/status');
        const status = await res.json();
        updateIndexStatusUI(status);
    } catch (err) {
        document.getElementById('indexStatus').textContent = 'Could not check index status';
    }
}

function updateIndexStatusUI(status) {
    const el = document.getElementById('indexStatus');
    const newCount = status.new_images || 0;
    const autoThreshold = status.auto_build_threshold || 0;

    if (status.building) {
        el.textContent = 'Index build in progress...';
        buildIndexBtn.disabled = true;
        buildIndexBtn.textContent = 'Building...';
    } else if (status.exists) {
        let text = `Index: ${status.face_count || '?'} faces from ${status.image_count || '?'} images (updated ${status.last_updated || 'unknown'})`;
        if (newCount > 0) {
            text += ` | ${newCount} new image${newCount !== 1 ? 's' : ''} to index`;
            if (autoThreshold > 0 && newCount < autoThreshold) {
                text += ` (auto-build at ${autoThreshold})`;
            }
            buildIndexBtn.disabled = false;
            buildIndexBtn.textContent = `Update Index (${newCount} new)`;
        } else {
            buildIndexBtn.disabled = true;
            buildIndexBtn.textContent = 'Index Up to Date';
        }
        el.textContent = text;
    } else {
        el.textContent = 'No face index found. Build one to enable search.';
        buildIndexBtn.disabled = false;
        buildIndexBtn.textContent = 'Build Index';
    }
}

// Auto-build threshold management
function loadAutoBuildThreshold() {
    const saved = localStorage.getItem('autoBuildThreshold');
    if (saved) {
        autoBuildThreshold = parseInt(saved);
        autoBuildInput.value = autoBuildThreshold;
        updateAutoBuildStatus(autoBuildThreshold);
        // Sync with server on page load
        syncAutoBuildWithServer(autoBuildThreshold);
    } else {
        updateAutoBuildStatus(0);
    }
}

async function saveAutoBuildThreshold() {
    const value = parseInt(autoBuildInput.value);
    
    if (isNaN(value) || value < 0) {
        alert('Please enter a valid number (0 or greater)');
        return;
    }
    
    // Save to server
    try {
        const response = await fetch('/api/face-index/auto-build-threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold: value })
        });
        
        const data = await response.json();
        
        if (data.success) {
            autoBuildThreshold = value;
            if (value > 0) {
                localStorage.setItem('autoBuildThreshold', value);
            } else {
                localStorage.removeItem('autoBuildThreshold');
            }
            updateAutoBuildStatus(value);
            alert(data.message);
        } else {
            alert('Failed to save threshold: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Error saving threshold: ' + err.message);
    }
}

async function disableAutoBuild() {
    if (!confirm('Disable auto-build? You will need to manually rebuild the face index.')) {
        return;
    }
    
    try {
        const response = await fetch('/api/face-index/auto-build-threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold: 0 })
        });
        
        const data = await response.json();
        
        if (data.success) {
            autoBuildThreshold = 0;
            autoBuildInput.value = '';
            localStorage.removeItem('autoBuildThreshold');
            updateAutoBuildStatus(0);
            alert('Auto-build disabled successfully');
        } else {
            alert('Failed to disable: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Error disabling auto-build: ' + err.message);
    }
}

function updateAutoBuildStatus(threshold) {
    if (threshold > 0) {
        autoBuildStatus.textContent = `✓ Active (${threshold})`;
        autoBuildStatus.className = 'auto-build-status';
        disableAutoBuildBtn.disabled = false;
    } else {
        autoBuildStatus.textContent = 'Disabled';
        autoBuildStatus.className = 'auto-build-status disabled';
        disableAutoBuildBtn.disabled = true;
    }
}

async function syncAutoBuildWithServer(threshold) {
    try {
        await fetch('/api/face-index/auto-build-threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold })
        });
    } catch (err) {
        console.error('Failed to sync auto-build threshold:', err);
    }
}

async function buildIndex() {
    buildIndexBtn.disabled = true;
    buildIndexBtn.textContent = 'Building...';
    buildProgress.style.display = 'block';
    buildLog.innerHTML = '<p>Starting index build...</p>';

    try {
        const res = await fetch('/api/face-index/build', { method: 'POST' });
        const data = await res.json();

        if (data.error) {
            buildLog.innerHTML += `<p class="error">${data.error}</p>`;
            buildIndexBtn.disabled = false;
            buildIndexBtn.textContent = 'Build Index';
        }
    } catch (err) {
        buildLog.innerHTML += `<p class="error">Error: ${err.message}</p>`;
        buildIndexBtn.disabled = false;
        buildIndexBtn.textContent = 'Build Index';
    }
}

// Socket.IO events for index build progress
socket.on('face-index-progress', (data) => {
    if (data.message) {
        buildLog.innerHTML += `<p>${escapeHtml(data.message)}</p>`;
        buildLog.scrollTop = buildLog.scrollHeight;
    }
});

socket.on('face-index-complete', (data) => {
    buildIndexBtn.disabled = false;
    buildIndexBtn.textContent = 'Update Index';
    if (data.success) {
        buildLog.innerHTML += '<p class="success">Index build complete!</p>';
    } else {
        buildLog.innerHTML += `<p class="error">Index build failed: ${escapeHtml(data.output || 'Unknown error')}</p>`;
    }
    buildLog.scrollTop = buildLog.scrollHeight;
    loadIndexStatus();
});

// Helpers
function getSourceClass(source) {
    if (!source) return 'unknown';
    if (source.includes('ittefaq')) return 'ittefaq';
    if (source.includes('jugantor')) return 'jugantor';
    if (source.includes('kalbela')) return 'kalbela';
    if (source.includes('desh')) return 'desh';
    if (source.includes('dhakapost')) return 'dhakapost';
    if (source.includes('jagonews24')) return 'jagonews24';
    if (source.includes('bdnews24')) return 'bdnews24';
    if (source.includes('prothomalo')) return 'prothomalo';
    if (source.includes('samakal')) return 'samakal';
    if (source.includes('sangbad')) return 'sangbad';
    if (source.includes('amadershomoy')) return 'amadershomoy';
    if (source.includes('bdpratidin') || source.includes('bd-pratidin')) return 'bdpratidin';
    if (source.includes('mzamin')) return 'mzamin';
    if (source.includes('dhakatribune')) return 'dhakatribune';
    if (source.includes('janakantha')) return 'janakantha';
    if (source.includes('boishakhi')) return 'boishakhi';
    return 'unknown';
}

function getSourceName(source) {
    if (!source) return 'Unknown';
    if (source.includes('ittefaq')) return 'Ittefaq';
    if (source.includes('jugantor')) return 'Jugantor';
    if (source.includes('kalbela')) return 'Kalbela';
    if (source.includes('desh')) return 'Desh TV';
    if (source.includes('dhakapost')) return 'DhakaPost';
    if (source.includes('jagonews24')) return 'Jagonews24';
    if (source.includes('bdnews24')) return 'BDNews24';
    if (source.includes('prothomalo')) return 'Prothom Alo';
    if (source.includes('samakal')) return 'Samakal';
    if (source.includes('sangbad')) return 'Sangbad';
    if (source.includes('amadershomoy')) return 'AmaderShomoy';
    if (source.includes('bdpratidin') || source.includes('bd-pratidin')) return 'BD Pratidin';
    if (source.includes('mzamin')) return 'Mzamin';
    if (source.includes('dhakatribune')) return 'Dhaka Tribune';
    if (source.includes('janakantha')) return 'Janakantha';
    if (source.includes('boishakhi')) return 'Boishakhi';
    return source;
}

function formatDate(dateString) {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return dateString;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Relation Search
async function searchRelations() {
    if (selectedFiles.length === 0) return;

    loadingOverlay.style.display = 'flex';
    loadingText.textContent = `Analyzing relations from ${selectedFiles.length} image${selectedFiles.length > 1 ? 's' : ''}...`;
    resultsSection.style.display = 'none';
    relationResultsSection.style.display = 'none';
    emptyState.style.display = 'none';
    searchBtn.disabled = true;

    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('images', file));
    formData.append('threshold', thresholdSlider.value);
    formData.append('clusterThreshold', clusterThresholdSlider.value);
    formData.append('strategy', 'hybrid');

    try {
        const response = await fetch('/api/face-relation-search', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        loadingOverlay.style.display = 'none';
        searchBtn.disabled = false;

        if (!response.ok || data.error) {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = data.error || data.message || 'Relation search failed.';
            return;
        }

        if (data.associates && data.associates.length > 0) {
            renderRelationResults(data);
        } else {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = data.message || 'No recurring associates found. The target person may not appear with others frequently enough (minimum 2 co-appearances required).';
        }
    } catch (err) {
        loadingOverlay.style.display = 'none';
        searchBtn.disabled = false;
        emptyState.style.display = 'block';
        document.getElementById('emptyText').textContent = 'Error: ' + err.message;
    }
}

function renderRelationResults(data) {
    relationResultsTitle.textContent = `Target found in ${data.target_images} images — ${data.associates.length} associated ${data.associates.length === 1 ? 'person' : 'people'}`;
    relationResultsSection.style.display = 'block';
    relationResultsContainer.innerHTML = '';

    for (const assoc of data.associates) {
        const group = document.createElement('div');
        group.className = 'relation-group';

        const header = document.createElement('div');
        header.className = 'relation-group-header';
        header.onclick = () => {
            group.classList.toggle('expanded');
        };

        // Face crop thumbnail
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'relation-face-thumb';
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 128;
        thumbCanvas.height = 128;
        thumbContainer.appendChild(thumbCanvas);

        // Load representative image and crop face (centered square crop)
        const repImg = new Image();
        repImg.crossOrigin = 'anonymous';
        repImg.onload = () => {
            const ctx = thumbCanvas.getContext('2d');
            const [x1, y1, x2, y2] = assoc.representative.bbox;
            // Center of the face
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            // Square crop: use largest dimension + 60% padding
            const faceSize = Math.max(x2 - x1, y2 - y1);
            const cropSize = faceSize * 1.6;
            // Clamp to image bounds
            let sx = Math.max(0, cx - cropSize / 2);
            let sy = Math.max(0, cy - cropSize / 2);
            let sw = Math.min(repImg.width - sx, cropSize);
            let sh = Math.min(repImg.height - sy, cropSize);
            // Keep square by using the smaller dimension
            const side = Math.min(sw, sh);
            ctx.drawImage(repImg, sx, sy, side, side, 0, 0, 128, 128);
        };
        repImg.src = `/news_images/${assoc.representative.image}`;

        const info = document.createElement('div');
        info.className = 'relation-group-info';
        info.innerHTML = `
            <span class="relation-count">Appeared with target: <strong>${assoc.count} images</strong></span>
            <span class="relation-expand-hint">${assoc.count} co-appearances — click to ${assoc.count <= 6 ? 'view' : 'expand'}</span>
        `;

        const arrow = document.createElement('div');
        arrow.className = 'relation-expand-arrow';
        arrow.textContent = '\u25BC';

        header.appendChild(thumbContainer);
        header.appendChild(info);
        header.appendChild(arrow);
        group.appendChild(header);

        // Expandable images grid
        const body = document.createElement('div');
        body.className = 'relation-group-body';

        const grid = document.createElement('div');
        grid.className = 'relation-images-grid';

        for (const img of assoc.images) {
            const scoreClass = img.source_site ? `source-${getSourceClass(img.source_site)}` : '';
            const card = document.createElement('div');
            card.className = 'result-card';
            const clusterPercent = img.cluster_sim != null ? Math.round(img.cluster_sim * 100) : null;
            const simClass = clusterPercent >= 70 ? 'score-high' : clusterPercent >= 50 ? 'score-medium' : 'score-low';
            card.innerHTML = `
                <div class="result-image-container">
                    <img src="/news_images/${img.image}" alt="Co-appearance" class="result-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22><rect fill=%22%23ddd%22 width=%22200%22 height=%22150%22/><text fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22>No Image</text></svg>'">
                    ${clusterPercent != null ? `<span class="score-badge ${simClass}">${clusterPercent}%</span>` : ''}
                </div>
                <div class="result-info">
                    ${img.headline ? `<p class="result-headline" title="${escapeHtml(img.headline)}">${escapeHtml(img.headline)}</p>` : '<p class="result-headline no-article">No linked article</p>'}
                    <div class="result-meta">
                        ${img.source_site ? `<span class="source-badge ${scoreClass}">${getSourceName(img.source_site)}</span>` : ''}
                        ${img.published_at ? `<span class="result-date">${formatDate(img.published_at)}</span>` : ''}
                    </div>
                    <a href="article-view.html?image=${encodeURIComponent(img.image)}&highlight=${encodeURIComponent(JSON.stringify(img.assoc_bbox))}" class="result-link">View Details</a>
                </div>
            `;

            // Add circle highlight on the associate's face
            const cardImg = card.querySelector('.result-image');
            const assocBbox = img.assoc_bbox;
            if (assocBbox) {
                cardImg.addEventListener('load', function() {
                    const [bx1, by1, bx2, by2] = assocBbox;
                    const nw = this.naturalWidth;
                    const nh = this.naturalHeight;
                    const cx = (bx1 + bx2) / 2;
                    const cy = (by1 + by2) / 2;
                    // 35% padding around face for a generous circle
                    const faceSize = Math.max(bx2 - bx1, by2 - by1);
                    const r = faceSize * 0.68;
                    const sw = Math.max(3, Math.round(r * 0.1));

                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('class', 'face-highlight-svg');
                    svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
                    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', cx);
                    circle.setAttribute('cy', cy);
                    circle.setAttribute('r', r);
                    circle.setAttribute('stroke', '#667eea');
                    circle.setAttribute('stroke-width', sw);
                    circle.setAttribute('fill', 'none');

                    svg.appendChild(circle);
                    this.parentElement.appendChild(svg);
                });
            }

            grid.appendChild(card);
        }

        body.appendChild(grid);
        group.appendChild(body);
        relationResultsContainer.appendChild(group);
    }
}

// Pair Search
async function searchPair() {
    if (selectedFilesA.length === 0 || selectedFilesB.length === 0) return;

    loadingOverlay.style.display = 'flex';
    loadingText.textContent = `Finding images where both people appear together...`;
    pairResultsSection.style.display = 'none';
    emptyState.style.display = 'none';
    pairSearchBtn.disabled = true;

    const formData = new FormData();
    selectedFilesA.forEach(file => formData.append('imagesA', file));
    selectedFilesB.forEach(file => formData.append('imagesB', file));
    formData.append('threshold', pairThresholdSlider.value);

    try {
        const response = await fetch('/api/face-pair-search', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        loadingOverlay.style.display = 'none';
        pairSearchBtn.disabled = false;

        if (!response.ok || data.error) {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = data.error || 'Pair search failed.';
            return;
        }

        if (data.matches && data.matches.length > 0) {
            renderPairResults(data.matches);
        } else {
            emptyState.style.display = 'block';
            document.getElementById('emptyText').textContent = 'No images found where both people appear together. Try lowering the similarity threshold.';
        }
    } catch (err) {
        loadingOverlay.style.display = 'none';
        pairSearchBtn.disabled = false;
        emptyState.style.display = 'block';
        document.getElementById('emptyText').textContent = 'Error: ' + err.message;
    }
}

function renderPairResults(matches) {
    pairResultsTitle.textContent = `Found ${matches.length} image${matches.length !== 1 ? 's' : ''} where both appear together`;
    pairResultsSection.style.display = 'block';
    pairResultsGrid.innerHTML = '';

    for (const match of matches) {
        const avgScore = ((match.score_a + match.score_b) / 2);
        const scorePercent = Math.round(avgScore * 100);
        const scoreClass = scorePercent >= 70 ? 'score-high' : scorePercent >= 50 ? 'score-medium' : 'score-low';
        const sourceName = getSourceName(match.source_site);
        const sourceClass = getSourceClass(match.source_site);

        const card = document.createElement('div');
        card.className = 'result-card';
        card.innerHTML = `
            <div class="result-image-container">
                <img src="/news_images/${match.image}" alt="Match" class="result-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22><rect fill=%22%23ddd%22 width=%22200%22 height=%22150%22/><text fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22>No Image</text></svg>'">
                <span class="score-badge ${scoreClass}">${scorePercent}%</span>
            </div>
            <div class="result-info">
                <div class="pair-scores">
                    <span class="pair-score-label">A: ${Math.round(match.score_a * 100)}%</span>
                    <span class="pair-score-label">B: ${Math.round(match.score_b * 100)}%</span>
                </div>
                ${match.headline ? `<p class="result-headline" title="${escapeHtml(match.headline)}">${escapeHtml(match.headline)}</p>` : '<p class="result-headline no-article">No linked article</p>'}
                <div class="result-meta">
                    ${match.source_site ? `<span class="source-badge source-${sourceClass}">${sourceName}</span>` : ''}
                    ${match.published_at ? `<span class="result-date">${formatDate(match.published_at)}</span>` : ''}
                </div>
                <a href="article-view.html?image=${encodeURIComponent(match.image)}" class="result-link">View Details</a>
            </div>
        `;

        // Add face highlight circles for both A and B
        const cardImg = card.querySelector('.result-image');
        cardImg.addEventListener('load', function() {
            const nw = this.naturalWidth;
            const nh = this.naturalHeight;

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'face-highlight-svg');
            svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
            svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

            // Person A circle (blue)
            if (match.bbox_a) {
                const [ax1, ay1, ax2, ay2] = match.bbox_a;
                const acx = (ax1 + ax2) / 2;
                const acy = (ay1 + ay2) / 2;
                const aSize = Math.max(ax2 - ax1, ay2 - ay1);
                const ar = aSize * 0.68;
                const asw = Math.max(3, Math.round(ar * 0.1));
                const circleA = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circleA.setAttribute('cx', acx);
                circleA.setAttribute('cy', acy);
                circleA.setAttribute('r', ar);
                circleA.setAttribute('stroke', '#667eea');
                circleA.setAttribute('stroke-width', asw);
                circleA.setAttribute('fill', 'none');
                svg.appendChild(circleA);

                // Label A
                const textA = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                textA.setAttribute('x', acx);
                textA.setAttribute('y', acy - ar - asw * 2);
                textA.setAttribute('text-anchor', 'middle');
                textA.setAttribute('fill', '#667eea');
                textA.setAttribute('font-size', Math.max(14, aSize * 0.25));
                textA.setAttribute('font-weight', 'bold');
                textA.textContent = 'A';
                svg.appendChild(textA);
            }

            // Person B circle (green)
            if (match.bbox_b) {
                const [bx1, by1, bx2, by2] = match.bbox_b;
                const bcx = (bx1 + bx2) / 2;
                const bcy = (by1 + by2) / 2;
                const bSize = Math.max(bx2 - bx1, by2 - by1);
                const br = bSize * 0.68;
                const bsw = Math.max(3, Math.round(br * 0.1));
                const circleB = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circleB.setAttribute('cx', bcx);
                circleB.setAttribute('cy', bcy);
                circleB.setAttribute('r', br);
                circleB.setAttribute('stroke', '#27ae60');
                circleB.setAttribute('stroke-width', bsw);
                circleB.setAttribute('fill', 'none');
                svg.appendChild(circleB);

                // Label B
                const textB = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                textB.setAttribute('x', bcx);
                textB.setAttribute('y', bcy - br - bsw * 2);
                textB.setAttribute('text-anchor', 'middle');
                textB.setAttribute('fill', '#27ae60');
                textB.setAttribute('font-size', Math.max(14, bSize * 0.25));
                textB.setAttribute('font-weight', 'bold');
                textB.textContent = 'B';
                svg.appendChild(textB);
            }

            this.parentElement.appendChild(svg);
        });

        pairResultsGrid.appendChild(card);
    }
}

// State persistence functions
function saveSearchState(matches, imagesProcessed) {
    const state = {
        matches,
        imagesProcessed,
        timestamp: Date.now()
    };
    sessionStorage.setItem('faceSearchResults', JSON.stringify(state));
}

function restoreSearchState() {
    const saved = sessionStorage.getItem('faceSearchResults');
    if (!saved) return;
    
    try {
        const state = JSON.parse(saved);
        
        // Only restore if less than 30 minutes old
        if (Date.now() - state.timestamp > 30 * 60 * 1000) {
            sessionStorage.removeItem('faceSearchResults');
            return;
        }
        
        // Restore results
        if (state.matches && state.matches.length > 0) {
            if (state.imagesProcessed > 1) {
                resultsTitle.textContent = `Found ${state.matches.length} match${state.matches.length !== 1 ? 'es' : ''} (using ${state.imagesProcessed} images)`;
            }
            renderResults(state.matches);
        }
    } catch (err) {
        console.error('Failed to restore search state:', err);
        sessionStorage.removeItem('faceSearchResults');
    }
}

