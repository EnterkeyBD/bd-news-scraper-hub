// Get image name from URL query parameter
const urlParams = new URLSearchParams(window.location.search);
const imageName = urlParams.get('image');

// Source site configurations (same as find-people.js)
const SOURCE_CONFIGS = {
    'ittefaq.com.bd': { name: 'Ittefaq', color: 'ittefaq' },
    'jugantor.com': { name: 'Jugantor', color: 'jugantor' },
    'kalbelabd.com': { name: 'Kalbela', color: 'kalbela' },
    'deshrupantor.com': { name: 'Desh Rupantor', color: 'desh' },
    'dhakapost.com': { name: 'Dhaka Post', color: 'dhakapost' },
    'jagonews24.com': { name: 'Jagonews24', color: 'jagonews24' },
    'bdnews24.com': { name: 'BDNews24', color: 'bdnews24' },
    'prothomalo.com': { name: 'Prothom Alo', color: 'prothomalo' },
    'samakal.com': { name: 'Samakal', color: 'samakal' },
    'sangbad.net.bd': { name: 'Sangbad', color: 'sangbad' },
    'dainikamadershomoy.com': { name: 'AmaderShomoy', color: 'amadershomoy' },
    'bd-pratidin.com': { name: 'BD Pratidin', color: 'bdpratidin' },
    'mzamin.com': { name: 'Mzamin', color: 'mzamin' },
    'dhakatribune.com': { name: 'Dhaka Tribune', color: 'dhakatribune' },
    'dailyjanakantha.com': { name: 'Janakantha', color: 'janakantha' },
    'boishakhionline.com': { name: 'Boishakhi', color: 'boishakhi' }
};

// DOM Elements
const loadingOverlay = document.getElementById('loadingOverlay');
const articleContainer = document.getElementById('articleContainer');
const imageOnlyContainer = document.getElementById('imageOnlyContainer');
const errorContainer = document.getElementById('errorContainer');

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
    if (!imageName) {
        showError('No image specified in URL');
        return;
    }
    fetchArticleData();
});

// Fetch article data from API
async function fetchArticleData() {
    try {
        const response = await fetch(`/api/article/by-image/${encodeURIComponent(imageName)}`);

        if (!response.ok) {
            throw new Error('Failed to fetch article data');
        }

        const data = await response.json();

        if (data.found && data.article) {
            displayArticle(data.article);
        } else {
            displayImageOnly(imageName);
        }
    } catch (error) {
        console.error('Error fetching article:', error);
        showError('Failed to load article. Please try again.');
    }
}

// Display full article with all details
function displayArticle(article) {
    loadingOverlay.style.display = 'none';
    articleContainer.style.display = 'block';

    // Article Image
    const articleImage = document.getElementById('articleImage');
    articleImage.src = `/news_images/${article.image_name}`;
    articleImage.alt = article.headline || 'Article Image';

    // Source Badge
    const sourceBadge = document.getElementById('sourceBadge');
    const sourceConfig = SOURCE_CONFIGS[article.source_site] || { name: article.source_site, color: 'default' };
    sourceBadge.textContent = sourceConfig.name;
    sourceBadge.className = `source-badge badge-${sourceConfig.color}`;

    // Published Date
    const publishedDate = document.getElementById('publishedDate');
    if (article.published_at) {
        const date = new Date(article.published_at);
        publishedDate.textContent = date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } else {
        publishedDate.textContent = 'Date not available';
    }

    // Headline
    const articleHeadline = document.getElementById('articleHeadline');
    articleHeadline.textContent = article.headline || 'No headline available';

    // Category
    const articleCategory = document.getElementById('articleCategory');
    articleCategory.textContent = article.category || 'Uncategorized';

    // Image Name
    const articleImageName = document.getElementById('articleImageName');
    articleImageName.textContent = article.image_name || '-';

    // Tags
    const tagsSection = document.getElementById('tagsSection');
    const tagsContainer = document.getElementById('tagsContainer');
    if (article.tags && article.tags.trim()) {
        const tags = article.tags.split(',').map(tag => tag.trim()).filter(tag => tag);
        if (tags.length > 0) {
            tagsSection.style.display = 'block';
            tagsContainer.innerHTML = tags.map(tag =>
                `<span class="tag">${escapeHtml(tag)}</span>`
            ).join('');
        }
    }

    // Article Content
    const articleContent = document.getElementById('articleContent');
    if (article.content && article.content.trim()) {
        // Split content into paragraphs and display
        const paragraphs = article.content.split('\n').filter(p => p.trim());
        articleContent.innerHTML = paragraphs.map(p =>
            `<p>${escapeHtml(p)}</p>`
        ).join('');
    } else {
        articleContent.innerHTML = '<p class="no-content">No content available</p>';
    }

    // View Original Article Link
    const viewArticleLink = document.getElementById('viewArticleLink');
    if (article.source_url) {
        viewArticleLink.href = article.source_url;
        viewArticleLink.style.display = 'inline-block';
    } else {
        viewArticleLink.style.display = 'none';
    }
}

// Display image-only state when no article data is found
function displayImageOnly(imageName) {
    loadingOverlay.style.display = 'none';
    imageOnlyContainer.style.display = 'flex';

    const imageOnlyImg = document.getElementById('imageOnlyImg');
    imageOnlyImg.src = `/news_images/${imageName}`;
    imageOnlyImg.alt = 'News Image';
    imageOnlyImg.onerror = () => {
        imageOnlyImg.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"%3E%3Crect fill="%23e0e0e0" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="16"%3EImage Not Found%3C/text%3E%3C/svg%3E';
    };

    const imageOnlyFilename = document.getElementById('imageOnlyFilename');
    imageOnlyFilename.textContent = imageName;
}

// Show error message
function showError(message) {
    loadingOverlay.style.display = 'none';
    errorContainer.style.display = 'flex';

    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;
}

// Handle image loading errors
function handleImageError(img) {
    img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"%3E%3Crect fill="%23f0f0f0" width="400" height="300"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="18"%3EImage Not Available%3C/text%3E%3C/svg%3E';
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
