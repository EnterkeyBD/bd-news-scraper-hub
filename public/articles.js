// Articles page functionality
let currentPage = 1;
let perPage = 50;
let totalArticles = 0;
let currentFilters = {
    source: '',
    date: '',
    category: '',
    search: ''
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    loadStatistics();
    loadCategories();
    loadArticles();
    setupEventListeners();

    // --- Recheck Articles Button Logic ---

    const recheckBtn = document.getElementById('recheck-articles-btn');
    const progressContainer = document.getElementById('recheck-progress-container');
    const progressText = document.getElementById('recheck-progress-text');
    const progressBar = document.getElementById('recheck-progress-bar');

    if (recheckBtn) {
        recheckBtn.addEventListener('click', async function() {
            recheckBtn.disabled = true;
            recheckBtn.textContent = 'Rechecking...';

            // Show progress bar immediately with initial state
            if (progressContainer && progressText && progressBar) {
                progressContainer.style.display = 'block';
                progressText.textContent = 'Rechecking: 0/0 (starting...)';
                progressBar.style.width = '0%';
            }

            try {
                const resp = await fetch('/api/recheck-articles', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    showNotification('Recheck started', 'info');
                } else {
                    showNotification('Failed to start recheck', 'error');
                    if (progressContainer) progressContainer.style.display = 'none';
                }
            } catch (e) {
                showNotification('Error triggering recheck', 'error');
                if (progressContainer) progressContainer.style.display = 'none';
            }
            setTimeout(() => {
                recheckBtn.disabled = false;
                recheckBtn.textContent = '🔄 Recheck All Articles';
            }, 3000);
        });
    }

    // --- Socket notification for recheck progress and finished ---
    if (typeof io !== 'undefined') {
        const socket = io();

        socket.on('recheck-progress', ({ current, total }) => {
            if (progressContainer && progressText && progressBar) {
                progressContainer.style.display = 'block';
                progressText.textContent = `Rechecking: ${current}/${total}`;
                const percent = total > 0 ? (current / total) * 100 : 0;
                progressBar.style.width = `${percent}%`;
            }
        });

        socket.on('recheck-finished', (data) => {
            if (progressContainer && progressText && progressBar) {
                progressText.textContent = 'Rechecking complete!';
                progressBar.style.width = '100%';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 2000);
            }
            showNotification('Article recheck finished', data.code === 0 ? 'success' : 'error');
            // Reload articles to reflect any updates
            loadArticles();
            loadStatistics();
        });
    }

    // Scheduler modal logic
    const openSchedulerBtn = document.getElementById('open-scheduler-btn');
    const schedulerModal = document.getElementById('scheduler-modal');
    const closeSchedulerModal = document.getElementById('close-scheduler-modal');
    const schedulerForm = document.getElementById('scheduler-form');
    const resetScheduleBtn = document.getElementById('reset-schedule-btn');

    if (openSchedulerBtn && schedulerModal && closeSchedulerModal && schedulerForm) {
        // Load current schedule when opening modal
        openSchedulerBtn.onclick = async () => {
            schedulerModal.style.display = 'block';
            // Fetch current schedule
            try {
                const resp = await fetch('/api/schedule-recheck');
                const data = await resp.json();
                if (data.success && data.config) {
                    document.getElementById('schedule-type').value = data.config.type;
                    document.getElementById('schedule-time').value = data.config.time;
                } else {
                    // Clear form if no schedule is set
                    document.getElementById('schedule-type').value = 'daily';
                    document.getElementById('schedule-time').value = '';
                }
            } catch (err) {
                console.error('Error loading schedule:', err);
            }
        };
        
        closeSchedulerModal.onclick = () => schedulerModal.style.display = 'none';
        window.onclick = (event) => {
            if (event.target === schedulerModal) schedulerModal.style.display = 'none';
        };
        schedulerForm.onsubmit = async (e) => {
            e.preventDefault();
            const type = document.getElementById('schedule-type').value;
            const time = document.getElementById('schedule-time').value;
            try {
                const resp = await fetch('/api/schedule-recheck', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, time })
                });
                const data = await resp.json();
                if (data.success) {
                    showNotification('Scheduler set successfully', 'info');
                    schedulerModal.style.display = 'none';
                } else {
                    showNotification('Failed to set scheduler', 'error');
                }
            } catch (err) {
                showNotification('Error setting scheduler', 'error');
            }
        };

        // Reset schedule button
        if (resetScheduleBtn) {
            resetScheduleBtn.onclick = async () => {
                try {
                    const resp = await fetch('/api/reset-schedule-recheck', {
                        method: 'POST'
                    });
                    const data = await resp.json();
                    if (data.success) {
                        showNotification('Scheduler reset successfully', 'success');
                        // Clear form fields
                        document.getElementById('schedule-type').value = 'daily';
                        document.getElementById('schedule-time').value = '';
                        schedulerModal.style.display = 'none';
                    } else {
                        showNotification(data.message || 'Failed to reset scheduler', 'error');
                    }
                } catch (err) {
                    console.error('Reset error:', err);
                    showNotification('Error resetting scheduler', 'error');
                }
            };
        }
    }
});

// Setup event listeners
function setupEventListeners() {
    // Filter buttons
    document.getElementById('apply-filter-btn').addEventListener('click', applyFilters);
    document.getElementById('clear-filter-btn').addEventListener('click', clearFilters);
    
    // Search on enter key
    document.getElementById('search-input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            applyFilters();
        }
    });
    
    // Per page change
    document.getElementById('per-page-select').addEventListener('change', function() {
        perPage = parseInt(this.value);
        currentPage = 1;
        loadArticles();
    });
    
    // Pagination
    document.getElementById('first-page-btn').addEventListener('click', () => goToPage(1));
    document.getElementById('prev-page-btn').addEventListener('click', () => goToPage(currentPage - 1));
    document.getElementById('next-page-btn').addEventListener('click', () => goToPage(currentPage + 1));
    document.getElementById('last-page-btn').addEventListener('click', () => {
        const totalPages = Math.ceil(totalArticles / perPage);
        goToPage(totalPages);
    });
    
    // Modal close
    const modal = document.getElementById('article-modal');
    const closeBtn = modal.querySelector('.close');

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    // Edit modal close
    const editModal = document.getElementById('edit-article-modal');
    document.getElementById('close-edit-modal').addEventListener('click', () => {
        editModal.style.display = 'none';
    });

    // Image file input preview
    document.getElementById('edit-image-file').addEventListener('change', function() {
        const file = this.files[0];
        const preview = document.getElementById('edit-image-preview');
        const noImageText = document.getElementById('edit-no-image-text');
        const filenameSpan = document.getElementById('edit-image-filename');
        if (file) {
            filenameSpan.textContent = file.name;
            const reader = new FileReader();
            reader.onload = (e) => {
                preview.src = e.target.result;
                preview.style.display = 'block';
                noImageText.style.display = 'none';
            };
            reader.readAsDataURL(file);
        } else {
            filenameSpan.textContent = '';
        }
    });

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
        if (e.target === editModal) {
            editModal.style.display = 'none';
        }
    });
}

// Load statistics
async function loadStatistics() {
    try {
        const response = await fetch('/api/articles/stats');
        const stats = await response.json();
        
        document.getElementById('total-articles').textContent = stats.total || 0;
        document.getElementById('today-articles').textContent = stats.today || 0;
        document.getElementById('ittefaq-count').textContent = stats.ittefaq || 0;
        document.getElementById('jugantor-count').textContent = stats.jugantor || 0;
        document.getElementById('kalbela-count').textContent = stats.kalbela || 0;
        document.getElementById('desh-count').textContent = stats.desh || 0;
        document.getElementById('dhakapost-count').textContent = stats.dhakapost || 0;
        document.getElementById('jagonews24-count').textContent = stats.jagonews24 || 0;
        document.getElementById('bdnews24-count').textContent = stats.bdnews24 || 0;
        document.getElementById('prothomalo-count').textContent = stats.prothomalo || 0;
    } catch (error) {
        console.error('Error loading statistics:', error);
    }
}

// Load categories for filter
async function loadCategories() {
    try {
        const response = await fetch('/api/categories');
        const categories = await response.json();
        
        const categoryFilter = document.getElementById('category-filter');
        const uniqueCategories = [...new Set(categories.map(c => c.section_label))].sort();
        
        uniqueCategories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            categoryFilter.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading categories:', error);
    }
}

// Load articles
async function loadArticles() {
    const tbody = document.getElementById('articles-tbody');
    tbody.innerHTML = `
        <tr>
            <td colspan="7" class="loading-cell">
                <div class="loader"></div>
                <p>Loading articles...</p>
            </td>
        </tr>
    `;
    
    try {
        // Build query parameters
        const params = new URLSearchParams({
            page: currentPage,
            limit: perPage
        });
        
        if (currentFilters.source) params.append('source', currentFilters.source);
        if (currentFilters.date) params.append('date', currentFilters.date);
        if (currentFilters.category) params.append('category', currentFilters.category);
        if (currentFilters.search) params.append('search', currentFilters.search);
        
        const response = await fetch(`/api/articles?${params}`);
        const data = await response.json();
        
        totalArticles = data.total;
        displayArticles(data.articles);
        updatePaginationInfo();
    } catch (error) {
        console.error('Error loading articles:', error);
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">
                    <h3>Error Loading Articles</h3>
                    <p>${error.message}</p>
                </td>
            </tr>
        `;
    }
}

// Display articles in table
function displayArticles(articles) {
    const tbody = document.getElementById('articles-tbody');
    
    if (!articles || articles.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="empty-state">
                    <h3>No Articles Found</h3>
                    <p>Try adjusting your filters or search terms.</p>
                </td>
            </tr>
        `;
        return;
    }
    
    // Reset select-all checkbox state
    const selectAllCb = document.getElementById('select-all-checkbox');
    if (selectAllCb) selectAllCb.checked = false;

    tbody.innerHTML = articles.map(article => {
        const sourceClass = getSourceClass(article.source_site);
        const imageSrc = (article.image_name && article.image_name !== 'Not Available') ? `/news_images/${article.image_name}` : null;
        const publishedDate = formatDate(article.published_at);
        const isChecked = selectedArticleIds.has(article.id);
        
        return `
            <tr class="${isChecked ? 'row-selected' : ''}">
                <td class="col-check"><input type="checkbox" class="row-checkbox" value="${article.id}" ${isChecked ? 'checked' : ''} onchange="toggleSelectArticle(${article.id}, this.checked)"></td>
                <td>${article.id}</td>
                <td>
                    ${imageSrc ? 
                        `<img src="${imageSrc}" alt="Article image" class="article-thumbnail" 
                             onerror="this.parentElement.innerHTML='<div class=\\'no-image\\'>No Image</div>'"
                             onclick="viewArticle(${article.id})">` : 
                        '<div class="no-image">No Image</div>'
                    }
                </td>
                <td>
                    <div class="headline-text" onclick="viewArticle(${article.id})" style="cursor: pointer;">
                        ${escapeHtml(article.headline)}
                    </div>
                </td>
                <td>
                    <span class="source-badge source-${sourceClass}">
                        ${getSourceName(article.source_site)}
                    </span>
                </td>
                <td>
                    <span class="category-badge">
                        ${escapeHtml(getCategoryName(article.category))}
                    </span>
                </td>
                <td class="date-text">${publishedDate}</td>
                <td class="actions-cell">
                    <button class="action-btn btn-view" onclick="viewArticle(${article.id})" title="View">👁️</button>
                    <button class="action-btn btn-edit" onclick="editArticle(${article.id})" title="Edit">✏️</button>
                    ${article.source_url ? `<a href="${article.source_url}" target="_blank" class="action-btn btn-link" title="Source" style="text-decoration:none;">🔗</a>` : ''}
                    <button class="action-btn btn-delete" onclick="deleteArticle(${article.id})" title="Delete">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');
}

// ── Bulk selection state ──────────────────────────────────────
const selectedArticleIds = new Set();

function toggleSelectAll(checked) {
    document.querySelectorAll('.row-checkbox').forEach(cb => {
        const id = parseInt(cb.value);
        cb.checked = checked;
        cb.closest('tr').classList.toggle('row-selected', checked);
        checked ? selectedArticleIds.add(id) : selectedArticleIds.delete(id);
    });
    updateBulkBar();
}

function toggleSelectArticle(id, checked) {
    checked ? selectedArticleIds.add(id) : selectedArticleIds.delete(id);
    const cb = document.querySelector(`.row-checkbox[value='${id}']`);
    if (cb) cb.closest('tr').classList.toggle('row-selected', checked);
    // Update select-all checkbox state
    const allCbs = document.querySelectorAll('.row-checkbox');
    const selectAllCb = document.getElementById('select-all-checkbox');
    if (selectAllCb) selectAllCb.checked = allCbs.length > 0 && [...allCbs].every(c => c.checked);
    updateBulkBar();
}

function clearSelection() {
    selectedArticleIds.clear();
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    document.querySelectorAll('.row-selected').forEach(tr => tr.classList.remove('row-selected'));
    const selectAllCb = document.getElementById('select-all-checkbox');
    if (selectAllCb) selectAllCb.checked = false;
    updateBulkBar();
}

function updateBulkBar() {
    const bar = document.getElementById('bulk-action-bar');
    const countEl = document.getElementById('bulk-selected-count');
    const count = selectedArticleIds.size;
    bar.style.display = count > 0 ? 'flex' : 'none';
    countEl.textContent = `${count} article${count !== 1 ? 's' : ''} selected`;
}

async function deleteSelectedArticles() {
    const ids = [...selectedArticleIds];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected article${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
        const response = await fetch('/api/articles/bulk', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const result = await response.json();
        if (response.ok) {
            showNotification(`Deleted ${result.deletedCount} article${result.deletedCount !== 1 ? 's' : ''}`, 'success');
            clearSelection();
            loadArticles();
            loadStatistics();
        } else {
            showNotification(result.error || 'Failed to delete selected articles', 'error');
        }
    } catch (error) {
        console.error('Error bulk deleting articles:', error);
        showNotification('Failed to delete selected articles', 'error');
    }
}

// Delete article
async function deleteArticle(articleId) {
    if (!confirm('Are you sure you want to delete this article? This action cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/articles/${articleId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification('Article deleted successfully', 'success');
            // Reload articles and statistics
            loadArticles();
            loadStatistics();
        } else {
            showNotification(result.error || 'Failed to delete article', 'error');
        }
    } catch (error) {
        console.error('Error deleting article:', error);
        showNotification('Failed to delete article', 'error');
    }
}

// Delete all articles
async function deleteAllArticles() {
    if (!confirm('Are you sure you want to delete ALL articles? This will permanently delete all articles from the database. This action cannot be undone!')) {
        return;
    }
    
    // Double confirmation for safety
    if (!confirm('FINAL WARNING: This will delete ALL articles. Are you absolutely sure?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/articles', {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification(`Successfully deleted ${result.deletedCount} articles`, 'success');
            // Reload articles and statistics
            loadArticles();
            loadStatistics();
        } else {
            showNotification(result.error || 'Failed to delete all articles', 'error');
        }
    } catch (error) {
        console.error('Error deleting all articles:', error);
        showNotification('Failed to delete all articles', 'error');
    }
}

// View article details
async function viewArticle(articleId) {
    try {
        const response = await fetch(`/api/articles/${articleId}`);
        const article = await response.json();
        
        const modal = document.getElementById('article-modal');
        const detailsDiv = document.getElementById('article-details');
        const headline = document.getElementById('modal-headline');
        
        headline.textContent = article.headline;
        
        const imageSrc = (article.image_name && article.image_name !== 'Not Available') ? `/news_images/${article.image_name}` : null;
        
        detailsDiv.innerHTML = `
            <div class="detail-row">
                <div class="detail-label">ID</div>
                <div class="detail-value">${article.id}</div>
            </div>
            
            ${imageSrc ? `
                <div class="detail-row">
                    <div class="detail-label">Image</div>
                    <div class="detail-value">
                        <img src="${imageSrc}" alt="Article image" 
                             onerror="this.style.display='none'">
                    </div>
                </div>
            ` : ''}
            
            <div class="detail-row">
                <div class="detail-label">Source Website</div>
                <div class="detail-value">
                    <span class="source-badge source-${getSourceClass(article.source_site)}">
                        ${getSourceName(article.source_site)}
                    </span>
                </div>
            </div>
            
            <div class="detail-row">
                <div class="detail-label">Source Link</div>
                <div class="detail-value">
                    ${article.source_url ? 
                        `<a href="${article.source_url}" target="_blank" class="detail-link">${article.source_url}</a>` : 
                        'N/A'
                    }
                </div>
            </div>
            
            <div class="detail-row">
                <div class="detail-label">Category</div>
                <div class="detail-value">${escapeHtml(getCategoryName(article.category))}</div>
            </div>
            
            <div class="detail-row">
                <div class="detail-label">Published Date</div>
                <div class="detail-value">${formatDate(article.published_at)}</div>
            </div>
            
            <div class="detail-row">
                <div class="detail-label">Tags</div>
                <div class="detail-value">${article.tags || 'N/A'}</div>
            </div>
            
            <div class="detail-row">
                <div class="detail-label">Content</div>
                <div class="detail-value detail-content">${escapeHtml(article.content || 'No content available')}</div>
            </div>
        `;
        
        modal.style.display = 'block';
    } catch (error) {
        console.error('Error loading article details:', error);
        alert('Failed to load article details');
    }
}

// Apply filters
function applyFilters() {
    currentFilters.source = document.getElementById('source-filter').value;
    currentFilters.date = document.getElementById('date-filter').value;
    currentFilters.category = document.getElementById('category-filter').value;
    currentFilters.search = document.getElementById('search-input').value.trim();
    
    currentPage = 1;
    loadArticles();
}

// Clear filters
function clearFilters() {
    document.getElementById('source-filter').value = '';
    document.getElementById('date-filter').value = '';
    document.getElementById('category-filter').value = '';
    document.getElementById('search-input').value = '';
    
    currentFilters = {
        source: '',
        date: '',
        category: '',
        search: ''
    };
    
    currentPage = 1;
    loadArticles();
}

// Go to specific page
function goToPage(page) {
    const totalPages = Math.ceil(totalArticles / perPage);
    
    if (page < 1 || page > totalPages) return;
    
    currentPage = page;
    loadArticles();
}

// Update pagination info
function updatePaginationInfo() {
    const totalPages = Math.ceil(totalArticles / perPage);
    const showingFrom = totalArticles === 0 ? 0 : (currentPage - 1) * perPage + 1;
    const showingTo = Math.min(currentPage * perPage, totalArticles);
    
    document.getElementById('showing-from').textContent = showingFrom;
    document.getElementById('showing-to').textContent = showingTo;
    document.getElementById('total-count').textContent = totalArticles;
    document.getElementById('current-page').textContent = currentPage;
    document.getElementById('total-pages').textContent = totalPages || 1;
    
    // Enable/disable pagination buttons
    document.getElementById('first-page-btn').disabled = currentPage === 1;
    document.getElementById('prev-page-btn').disabled = currentPage === 1;
    document.getElementById('next-page-btn').disabled = currentPage === totalPages || totalPages === 0;
    document.getElementById('last-page-btn').disabled = currentPage === totalPages || totalPages === 0;
}

// Helper functions
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

// Maps numeric category IDs (used by Ittefaq) to readable names
const CATEGORY_ID_MAP = {
    '5':  'National',
    '6':  'World',
    '7':  'Crime',
    '8':  'Sports',
    '9':  'Economics',
    '10': 'Politics',
    '11': 'Country',
    '12': 'Capital',
    '13': 'Education',
    '14': 'Entertainment'
};

function getCategoryName(category) {
    if (!category) return 'N/A';
    const s = String(category).trim();
    return CATEGORY_ID_MAP[s] || s;
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    
    try {
        const date = new Date(dateString);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        return dateString;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Edit article - open edit modal with article data
async function editArticle(articleId) {
    try {
        const response = await fetch(`/api/articles/${articleId}`);
        const article = await response.json();

        document.getElementById('edit-article-id').value = article.id;
        document.getElementById('edit-headline').value = article.headline || '';
        document.getElementById('edit-tags').value = article.tags || '';
        document.getElementById('edit-content').value = article.content || '';

        // Reset file input
        document.getElementById('edit-image-file').value = '';
        document.getElementById('edit-image-filename').textContent = '';

        // Show current image
        const preview = document.getElementById('edit-image-preview');
        const noImageText = document.getElementById('edit-no-image-text');
        if (article.image_name && article.image_name !== 'Not Available') {
            preview.src = `/news_images/${article.image_name}`;
            preview.style.display = 'block';
            noImageText.style.display = 'none';
        } else {
            preview.style.display = 'none';
            noImageText.style.display = 'flex';
        }

        document.getElementById('edit-article-modal').style.display = 'block';
    } catch (error) {
        console.error('Error loading article for edit:', error);
        showNotification('Failed to load article for editing', 'error');
    }
}

// Save edited article
async function saveArticle() {
    const articleId = document.getElementById('edit-article-id').value;
    const headline = document.getElementById('edit-headline').value.trim();
    const tags = document.getElementById('edit-tags').value.trim();
    const content = document.getElementById('edit-content').value.trim();
    const imageFile = document.getElementById('edit-image-file').files[0];

    if (!headline) {
        showNotification('Headline cannot be empty', 'error');
        return;
    }

    const saveBtn = document.getElementById('save-article-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        // Upload image first if a new one was selected
        if (imageFile) {
            const formData = new FormData();
            formData.append('image', imageFile);
            const imgResp = await fetch(`/api/articles/${articleId}/image`, {
                method: 'POST',
                body: formData
            });
            const imgResult = await imgResp.json();
            if (!imgResp.ok) {
                showNotification(imgResult.error || 'Failed to upload image', 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Changes';
                return;
            }
        }

        // Update text fields
        const response = await fetch(`/api/articles/${articleId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ headline, tags, content })
        });
        const result = await response.json();

        if (response.ok) {
            showNotification('Article updated successfully', 'success');
            document.getElementById('edit-article-modal').style.display = 'none';
            loadArticles();
        } else {
            showNotification(result.error || 'Failed to update article', 'error');
        }
    } catch (error) {
        console.error('Error saving article:', error);
        showNotification('Failed to save article', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

// Close edit modal
function closeEditModal() {
    document.getElementById('edit-article-modal').style.display = 'none';
}

// Show notification
function showNotification(message, type = 'info') {
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
