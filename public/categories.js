const API_URL = 'http://localhost:3000/api';

let allCategories = [];
let currentSite = 'all';
let statusFilter = 'all'; // all, disabled, active
let selectedIds = new Set();
let treeData = {};

document.addEventListener('DOMContentLoaded', () => {
    loadCategories();
    loadStats();
    setupEventListeners();
});

function setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentSite = e.target.dataset.site;
            filterCategories();
        });
    });

    // Status filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            statusFilter = e.target.dataset.filter;
            filterCategories();
        });
    });

    // Expand disabled button
    document.getElementById('expandDisabledBtn').addEventListener('click', expandAllDisabled);

    const searchInput = document.getElementById('searchInput');
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            if (e.target.value.trim()) {
                searchCategories(e.target.value.trim());
            } else {
                filterCategories();
            }
        }, 300);
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadCategories();
        loadStats();
    });

    document.getElementById('bulkEnableBtn').addEventListener('click', () => bulkAction('enable'));
    document.getElementById('bulkDisableBtn').addEventListener('click', () => bulkAction('disable'));
    document.getElementById('clearSelectionBtn').addEventListener('click', clearSelection);
    
    // Add category modal
    const modal = document.getElementById('addCategoryModal');
    const addBtn = document.getElementById('addCategoryBtn');
    const closeBtn = modal.querySelector('.close');
    const cancelBtn = document.getElementById('cancelBtn');
    const form = document.getElementById('addCategoryForm');
    
    addBtn.addEventListener('click', () => {
        modal.style.display = 'block';
    });
    
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        form.reset();
    });
    
    cancelBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        form.reset();
    });
    
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
            form.reset();
        }
    });
    
    form.addEventListener('submit', handleAddCategory);
}

async function loadCategories() {
    const container = document.getElementById('categoriesTree');
    container.innerHTML = '<div class="loading">Loading categories...</div>';
    
    try {
        const response = await fetch(`${API_URL}/categories`);
        allCategories = await response.json();
        console.log(`Loaded ${allCategories.length} categories`);
        filterCategories();
    } catch (error) {
        console.error('Error loading categories:', error);
        container.innerHTML = '<div class="no-results">Failed to load categories</div>';
        showError('Failed to load categories');
    }
}

async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/stats`);
        const stats = await response.json();
        
        document.getElementById('totalCategories').textContent = stats.overall.total;
        document.getElementById('activeCategories').textContent = stats.overall.active;
        document.getElementById('disabledCategories').textContent = stats.overall.disabled;
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

function filterCategories() {
    let filtered = allCategories;
    
    if (currentSite !== 'all') {
        filtered = allCategories.filter(cat => cat.site === currentSite);
    }
    
    // Apply status filter
    if (statusFilter === 'disabled') {
        filtered = filtered.filter(cat => cat.is_active === 0);
    } else if (statusFilter === 'active') {
        filtered = filtered.filter(cat => cat.is_active === 1);
    }
    
    treeData = buildTree(filtered);
    renderTree();
    
    // Auto-expand if showing disabled only
    if (statusFilter === 'disabled') {
        setTimeout(() => expandAllNodes(), 100);
    }
}

function buildTree(categories) {
    const tree = {};
    
    categories.forEach(cat => {
        // Extract actual URL path structure
        const urlParts = extractUrlPath(cat.category_url);
        const site = cat.site; // Use site from database
        
        if (!tree[site]) {
            tree[site] = {
                name: site,
                label: site,
                children: {},
                categories: [],
                urlSegment: site,
                fullPath: [site]
            };
        }
        
        let current = tree[site];
        
        // Build tree based on actual URL path (not section_label)
        for (let i = 0; i < urlParts.length; i++) {
            const pathSegment = urlParts[i];
            
            if (!current.children[pathSegment]) {
                current.children[pathSegment] = {
                    name: pathSegment,
                    label: `${site}-${urlParts.slice(0, i + 1).join('-')}`,
                    children: {},
                    categories: [],
                    urlSegment: pathSegment,
                    fullPath: [site, ...urlParts.slice(0, i + 1)]
                };
            }
            
            current = current.children[pathSegment];
        }
        
        // Add category to the final node
        current.categories.push(cat);
    });
    
    return tree;
}

function extractUrlPath(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        return pathParts;
    } catch (e) {
        return [];
    }
}

function renderTree() {
    const container = document.getElementById('categoriesTree');
    
    if (Object.keys(treeData).length === 0) {
        container.innerHTML = '<div class="no-results">No categories found</div>';
        return;
    }
    
    container.innerHTML = '';
    
    const fragment = document.createDocumentFragment();
    
    Object.values(treeData).forEach(siteNode => {
        fragment.appendChild(createTreeNode(siteNode, 1));
    });
    
    container.appendChild(fragment);
}

function createTreeNode(node, level) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = `tree-node level-${level}`;
    
    const hasChildren = Object.keys(node.children).length > 0;
    const allCategories = getAllCategoriesInNode(node);
    const activeCount = allCategories.filter(c => c.is_active).length;
    const totalCount = allCategories.length;
    
    let statusClass = '';
    if (activeCount === totalCount && totalCount > 0) statusClass = 'active';
    else if (activeCount === 0) statusClass = 'disabled';
    else if (activeCount > 0) statusClass = 'partially-active';
    
    const header = document.createElement('div');
    header.className = `node-header ${statusClass} ${hasChildren ? 'has-children' : ''}`;
    
    if (hasChildren) {
        const expandIcon = document.createElement('span');
        expandIcon.className = 'expand-icon';
        expandIcon.innerHTML = '▶';
        expandIcon.onclick = (e) => {
            e.stopPropagation();
            toggleNode(nodeDiv, expandIcon);
        };
        header.appendChild(expandIcon);
    } else {
        header.appendChild(document.createElement('span'));
    }
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'node-checkbox';
    checkbox.checked = activeCount === totalCount && totalCount > 0;
    checkbox.indeterminate = activeCount > 0 && activeCount < totalCount;
    checkbox.onclick = (e) => {
        e.stopPropagation();
        handleNodeCheckbox(node, checkbox.checked);
    };
    header.appendChild(checkbox);
    
    const nodeInfo = document.createElement('div');
    nodeInfo.className = 'node-info';
    
    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = node.name.charAt(0).toUpperCase() + node.name.slice(1);
    nodeInfo.appendChild(label);
    
    // Show URL path structure
    if (node.urlSegment && node.urlSegment !== node.name) {
        const urlPath = document.createElement('span');
        urlPath.className = 'url-path';
        urlPath.textContent = `/${node.urlSegment}`;
        urlPath.title = 'URL path segment';
        nodeInfo.appendChild(urlPath);
    }
    
    if (totalCount > 0) {
        const count = document.createElement('span');
        count.className = 'node-count';
        count.textContent = `${activeCount}/${totalCount}`;
        nodeInfo.appendChild(count);
    }
    
    // Add disabled indicator if has disabled children
    const disabledCount = totalCount - activeCount;
    if (disabledCount > 0 && hasChildren) {
        const disabledBadge = document.createElement('span');
        disabledBadge.className = 'disabled-badge';
        disabledBadge.textContent = `${disabledCount} disabled`;
        disabledBadge.title = `This category contains ${disabledCount} disabled items`;
        nodeInfo.appendChild(disabledBadge);
    }
    
    header.appendChild(nodeInfo);
    
    if (node.categories.length === 1 && !hasChildren) {
        const actions = document.createElement('div');
        actions.className = 'node-actions';
        
        // Show full URL path as breadcrumb
        const urlBreadcrumb = document.createElement('span');
        urlBreadcrumb.className = 'url-breadcrumb';
        const urlParts = extractUrlPath(node.categories[0].category_url);
        urlBreadcrumb.textContent = urlParts.join(' › ');
        urlBreadcrumb.title = node.categories[0].category_url;
        actions.appendChild(urlBreadcrumb);
        
        const urlLink = document.createElement('a');
        urlLink.href = node.categories[0].category_url;
        urlLink.target = '_blank';
        urlLink.className = 'url-link';
        urlLink.textContent = '🔗';
        urlLink.title = node.categories[0].category_url;
        urlLink.onclick = (e) => e.stopPropagation();
        actions.appendChild(urlLink);
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = `btn btn-sm ${node.categories[0].is_active ? 'btn-danger' : 'btn-success'}`;
        toggleBtn.textContent = node.categories[0].is_active ? '✗' : '✓';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            toggleCategory(node.categories[0].id, node.categories[0].is_active);
        };
        actions.appendChild(toggleBtn);
        
        header.appendChild(actions);
    } else if (hasChildren) {
        // Show category level indicator for parent nodes
        const levelIndicator = document.createElement('span');
        levelIndicator.className = 'level-indicator';
        const categoryLevel = getCategoryLevel(node);
        levelIndicator.textContent = categoryLevel;
        levelIndicator.title = 'URL hierarchy level';
        header.querySelector('.node-info').appendChild(levelIndicator);
    }
    
    nodeDiv.appendChild(header);
    
    if (hasChildren) {
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'node-children';
        
        const childFragment = document.createDocumentFragment();
        Object.values(node.children).forEach(child => {
            childFragment.appendChild(createTreeNode(child, level + 1));
        });
        childrenDiv.appendChild(childFragment);
        
        nodeDiv.appendChild(childrenDiv);
    }
    
    return nodeDiv;
}

function getCategoryLevel(node) {
    // Special handling for country-news hierarchy
    if (node.fullPath && node.fullPath.includes('country-news')) {
        const countryNewsIndex = node.fullPath.indexOf('country-news');
        const depthAfterCountryNews = node.fullPath.length - countryNewsIndex - 1;
        
        if (node.urlSegment === 'country-news') {
            return 'Main Category';
        } else if (depthAfterCountryNews === 1) {
            return 'Division';
        } else if (depthAfterCountryNews === 2) {
            return 'District';
        } else if (depthAfterCountryNews === 3) {
            return 'Upazilla';
        } else if (depthAfterCountryNews > 3) {
            return 'Area';
        }
    }
    
    // Default labels for other categories
    const labels = ['Root', 'Main Category', 'Sub-Category', 'Sub-Sub Category', 'Deep Category'];
    const depth = node.label.split('-').length - 1;
    return labels[Math.min(depth, labels.length - 1)];
}

function getAllCategoriesInNode(node) {
    let categories = [...node.categories];
    
    Object.values(node.children).forEach(child => {
        categories = categories.concat(getAllCategoriesInNode(child));
    });
    
    return categories;
}

function toggleNode(nodeDiv, icon) {
    const children = nodeDiv.querySelector('.node-children');
    if (children) {
        children.classList.toggle('expanded');
        icon.classList.toggle('expanded');
    }
}

async function handleNodeCheckbox(node, checked) {
    const categories = getAllCategoriesInNode(node);
    const ids = categories.map(c => c.id);
    
    const checkbox = event.target;
    const nodeElement = checkbox.closest('.tree-node');
    checkbox.disabled = true;
    
    try {
        const response = await fetch(`${API_URL}/categories/bulk/${checked ? 'enable' : 'disable'}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids })
        });
        
        if (response.ok) {
            // Update in-memory data
            ids.forEach(id => {
                const cat = allCategories.find(c => c.id === id);
                if (cat) cat.is_active = checked ? 1 : 0;
            });
            
            // Update just this node's visual state
            updateNodeVisuals(nodeElement, node);
            
            // Update stats without reload
            await loadStats();
            
            showSuccess(`${ids.length} categories ${checked ? 'enabled' : 'disabled'}`);
        }
    } catch (error) {
        console.error('Error:', error);
        showError('Failed to update');
    } finally {
        checkbox.disabled = false;
    }
}

async function searchCategories(query) {
    try {
        const response = await fetch(`${API_URL}/search?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        treeData = buildTree(results);
        renderTree();
    } catch (error) {
        console.error('Error searching:', error);
        showError('Search failed');
    }
}

function clearSelection() {
    selectedIds.clear();
    updateBulkActions();
}

function updateBulkActions() {
    const bulkActions = document.getElementById('bulkActions');
    const selectedCount = document.getElementById('selectedCount');
    
    if (selectedIds.size > 0) {
        bulkActions.style.display = 'flex';
        selectedCount.textContent = `${selectedIds.size} selected`;
    } else {
        bulkActions.style.display = 'none';
    }
}

async function toggleCategory(id, currentStatus) {
    try {
        const response = await fetch(`${API_URL}/categories/${id}/toggle`, {
            method: 'PATCH'
        });
        
        if (response.ok) {
            // Update in-memory data
            const cat = allCategories.find(c => c.id === id);
            if (cat) cat.is_active = currentStatus ? 0 : 1;
            
            // Find and update the button and node
            const button = event.target;
            const nodeElement = button.closest('.tree-node');
            
            button.className = `btn btn-sm ${!currentStatus ? 'btn-danger' : 'btn-success'}`;
            button.textContent = !currentStatus ? '✗' : '✓';
            
            // Update parent nodes up the tree
            updateParentNodes(nodeElement);
            
            await loadStats();
            showSuccess(`Category ${currentStatus ? 'disabled' : 'enabled'}`);
        }
    } catch (error) {
        console.error('Error toggling category:', error);
        showError('Failed to toggle category');
    }
}

async function bulkAction(action) {
    if (selectedIds.size === 0) return;
    
    try {
        const response = await fetch(`${API_URL}/categories/bulk/${action}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: Array.from(selectedIds) })
        });
        
        if (response.ok) {
            clearSelection();
            await loadCategories();
            await loadStats();
            showSuccess(`${selectedIds.size} categories ${action}d`);
        }
    } catch (error) {
        console.error('Error bulk updating:', error);
        showError('Failed to update categories');
    }
}

function updateNodeVisuals(nodeElement, node) {
    if (!nodeElement) return;
    
    const allCategories = getAllCategoriesInNode(node);
    const activeCount = allCategories.filter(c => c.is_active).length;
    const totalCount = allCategories.length;
    
    const header = nodeElement.querySelector('.node-header');
    const checkbox = nodeElement.querySelector('.node-checkbox');
    const countSpan = nodeElement.querySelector('.node-count');
    
    // Update status class
    header.classList.remove('active', 'disabled', 'partially-active');
    if (activeCount === totalCount && totalCount > 0) {
        header.classList.add('active');
    } else if (activeCount === 0) {
        header.classList.add('disabled');
    } else if (activeCount > 0) {
        header.classList.add('partially-active');
    }
    
    // Update checkbox
    checkbox.checked = activeCount === totalCount && totalCount > 0;
    checkbox.indeterminate = activeCount > 0 && activeCount < totalCount;
    
    // Update count
    if (countSpan) {
        countSpan.textContent = `${activeCount}/${totalCount}`;
    }
    
    // Update parent nodes recursively
    updateParentNodes(nodeElement);
}

function updateParentNodes(nodeElement) {
    const parentNode = nodeElement.parentElement?.closest('.tree-node');
    if (!parentNode) return;
    
    // Recalculate parent node status
    const parentCheckbox = parentNode.querySelector('.node-checkbox');
    const parentHeader = parentNode.querySelector('.node-header');
    const parentCount = parentNode.querySelector('.node-count');
    
    // Get all child checkboxes
    const childCheckboxes = Array.from(parentNode.querySelectorAll('.tree-node > .node-header > .node-checkbox'));
    const checkedCount = childCheckboxes.filter(cb => cb.checked).length;
    const totalCount = childCheckboxes.length;
    
    // Update parent status
    parentHeader.classList.remove('active', 'disabled', 'partially-active');
    if (checkedCount === totalCount && totalCount > 0) {
        parentHeader.classList.add('active');
        parentCheckbox.checked = true;
        parentCheckbox.indeterminate = false;
    } else if (checkedCount === 0) {
        parentHeader.classList.add('disabled');
        parentCheckbox.checked = false;
        parentCheckbox.indeterminate = false;
    } else {
        parentHeader.classList.add('partially-active');
        parentCheckbox.checked = false;
        parentCheckbox.indeterminate = true;
    }
    
    // Recursively update grandparents
    updateParentNodes(parentNode);
}

async function bulkActionWithIds(action, ids) {
    if (ids.length === 0) return;
    
    try {
        const response = await fetch(`${API_URL}/categories/bulk/${action}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids })
        });
        
        if (response.ok) {
            await loadCategories();
            await loadStats();
            showSuccess(`${ids.length} categories ${action}d`);
        }
    } catch (error) {
        console.error('Error:', error);
        showError('Failed to update');
    }
}

function expandAllNodes() {
    document.querySelectorAll('.node-children').forEach(children => {
        children.classList.add('expanded');
    });
    document.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.add('expanded');
    });
}

function expandAllDisabled() {
    // First, collapse all
    document.querySelectorAll('.node-children').forEach(children => {
        children.classList.remove('expanded');
    });
    document.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.remove('expanded');
    });
    
    // Find all nodes with disabled items and expand their parents
    document.querySelectorAll('.tree-node').forEach(node => {
        const header = node.querySelector('.node-header');
        if (header.classList.contains('disabled') || header.classList.contains('partially-active')) {
            // Expand this node
            const children = node.querySelector('.node-children');
            const icon = node.querySelector('.expand-icon');
            if (children) children.classList.add('expanded');
            if (icon) icon.classList.add('expanded');
            
            // Expand all parent nodes
            let parent = node.parentElement;
            while (parent) {
                if (parent.classList.contains('tree-node')) {
                    const parentChildren = parent.querySelector('.node-children');
                    const parentIcon = parent.querySelector('.expand-icon');
                    if (parentChildren) parentChildren.classList.add('expanded');
                    if (parentIcon) parentIcon.classList.add('expanded');
                }
                parent = parent.parentElement;
            }
        }
    });
    
    showSuccess('Expanded all paths with disabled categories');
}

function showSuccess(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:20px;right:20px;background:#28a745;color:white;padding:15px 25px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:1000';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showError(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:20px;right:20px;background:#dc3545;color:white;padding:15px 25px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:1000';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
async function handleAddCategory(e) {
    e.preventDefault();
    
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;
    
    // Get form values
    const categoryUrl = document.getElementById('categoryUrl').value.trim();
    const sectionLabel = document.getElementById('sectionLabel').value.trim();
    const site = document.getElementById('site').value;
    const isActive = document.getElementById('isActive').checked;
    
    console.log('Submitting category:', { categoryUrl, sectionLabel, site, isActive });
    
    // Disable submit button
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';
    
    try {
        const response = await fetch(`${API_URL}/categories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category_url: categoryUrl,
                section_label: sectionLabel,
                site: site,
                is_active: isActive ? 1 : 0
            })
        });
        
        const data = await response.json();
        console.log('Server response:', data);
        
        if (response.ok) {
            // Close modal and reset form
            document.getElementById('addCategoryModal').style.display = 'none';
            form.reset();
            
            // Reload data
            await loadCategories();
            await loadStats();
            
            showSuccess('Category added successfully!');
        } else {
            const errorMsg = data.details ? `${data.error}: ${data.details}` : data.error;
            showError(errorMsg || 'Failed to add category');
            console.error('Server error:', data);
        }
    } catch (error) {
        console.error('Error adding category:', error);
        showError('Failed to add category. Please check console for details.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
    }
}
