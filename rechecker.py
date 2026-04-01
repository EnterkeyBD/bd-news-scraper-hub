import os
import sys
import string

# Configure UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

sys.path.append('.')
import rechecker_db as db
import time
from datetime import datetime
import requests
from bs4 import BeautifulSoup

try:
    import cloudscraper
    kalbela_session = cloudscraper.create_scraper()
except ImportError:
    kalbela_session = requests.Session()

# =============== SITE-SPECIFIC EXTRACTION LOGIC ===============
def extract_kalbela(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    # Headline: h1.details-title with fallback to any h1
    h = soup.find('h1', class_='details-title')
    if not h:
        h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
        # Strip trailing punctuation to match scraper storage format
        headline = headline.rstrip(string.punctuation + "।")
    # Content: first paragraph only (>20 chars), matching scraper logic
    c = soup.find('div', class_='dtl_content_section')
    if not c:
        c = soup.find('div', class_='dtl-class') or soup.find('div', class_='body-content')
    if c:
        for p in c.find_all('p'):
            text = p.get_text(strip=True)
            if text and len(text) > 20:
                content = text
                break
    # Image: img.detailImg with fallback scanning all imgs
    img = soup.find('img', class_='img-fluid detailImg')
    if not img:
        for i in soup.find_all('img'):
            if 'detailImg' in (i.get('class') or []):
                img = i
                break
    if img and img.get('src'):
        image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_desh(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    h = soup.find(class_='details-title')
    if h:
        headline = h.get_text(strip=True)
    c = soup.find(class_='dtl_content_section')
    if c:
        content = c.get_text(strip=True)
    img = soup.find('img', class_='img-fluid detailImg')
    if img and img.get('src'):
        image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_jugantor(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    # Headline from h1.my-3 with fallback
    h = soup.find('h1', class_='my-3')
    if not h:
        h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    # Content from desktopDetailBody
    c = soup.find('div', class_='desktopDetailBody')
    if c:
        # Remove script and style tags
        for script in c(["script", "style"]):
            script.decompose()
        content = c.get_text(separator='\n', strip=True)
    # Image from figure or desktopDetailPhotoDiv
    figure = soup.find('figure')
    if figure:
        img = figure.find('img')
        if img and img.get('src'):
            image_name = os.path.basename(img['src'])
    if not image_name:
        img_div = soup.find('div', class_='desktopDetailPhotoDiv')
        if img_div:
            img = img_div.find('img')
            if img and img.get('src'):
                image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_ittefaq(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    h = soup.find('h1', class_='title')
    if not h:
        h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    c = soup.find('div', class_='content_detail_each_group')
    if c:
        paragraphs = c.find_all('p')
        content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True)])
    img = soup.find('meta', property='og:image')
    if img and img.get('content'):
        image_name = os.path.basename(img['content'].split('?')[0])
    return headline, content, image_name

def extract_bdnews24(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    # Headline
    h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    # Content - try multiple selectors matching the actual scraper
    # Method 1: by ID (most specific for bdnews24)
    c = soup.find('div', id='contentDetails')
    if c:
        paragraphs = c.find_all('p')
        if paragraphs:
            content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True)])
    # Method 2: Fallback selectors
    if not content:
        content_selectors = [
            ('div', 'details-brief'),
            ('div', 'article-content'),
            ('div', 'custombody'),
            ('div', 'content'),
            ('div', 'story-content'),
        ]
        for tag, class_name in content_selectors:
            c = soup.find(tag, class_=class_name)
            if c:
                paragraphs = c.find_all('p')
                if paragraphs:
                    content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True)])
                    if content:
                        break
    # Image
    img = soup.find('img', class_='img-responsive')
    if img and img.get('src'):
        image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_prothomalo(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    # Content - find ALL story-element-text divs and combine them
    story_elements = soup.find_all('div', class_=lambda x: x and 'story-element-text' in str(x))
    if story_elements:
        content_parts = []
        for element in story_elements:
            text = element.get_text(strip=True)
            if text:
                content_parts.append(text)
        content = ' '.join(content_parts)
    img = soup.find('img')
    if img and img.get('src'):
        image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_dhakapost(html):
    import re
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    # Headline from h1
    h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    # Content from news-details div
    c = soup.find('div', class_=re.compile(r'news-details'))
    if c:
        paragraphs = c.find_all('p')
        content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True)])
    # Image - prefer preload link or CDN imgAll
    preload = soup.find('link', rel='preload', as_='image')
    if preload and preload.get('href') and 'cdn.dhakapost.com/media/imgAll' in preload.get('href', ''):
        image_name = os.path.basename(preload['href'])
    else:
        # Try img with w-full class
        img = soup.find('img', class_=re.compile(r'w-full'))
        if img and img.get('src') and 'cdn.dhakapost.com/media/imgAll' in img.get('src', ''):
            image_name = os.path.basename(img['src'])
    return headline, content, image_name

def extract_jagonews24(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    # Headline from h1 or h2
    h = soup.find('h1') or soup.find('h2')
    if h:
        headline = h.get_text(strip=True)
    # Content from content-details div
    c = soup.find('div', class_='content-details')
    if c:
        paragraphs = c.find_all('p')
        content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True)])
    # Image from og:image or CDN
    og_image = soup.find('meta', property='og:image')
    if og_image and og_image.get('content') and 'cdn.jagonews24.com' in og_image.get('content', ''):
        image_name = os.path.basename(og_image['content'])
    return headline, content, image_name

def extract_samakal(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1
    h = soup.find('h1')
    if not h:
        h = soup.find('div', class_='dheading')
        if h:
            h = h.find('h1')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from #contentDetails or .dNewsDesc
    content_selectors = [
        ('div', {'id': 'contentDetails'}),
        ('div', {'class': 'dNewsDesc'}),
        ('div', {'class': 'article-content'}),
        ('div', {'class': 'article-body'})
    ]
    for tag, attrs in content_selectors:
        c = soup.find(tag, attrs)
        if c:
            # Remove scripts and styles
            for script in c(['script', 'style', 'iframe']):
                script.decompose()
            paragraphs = c.find_all('p')
            if paragraphs:
                content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 20])
                if content:
                    break
    
    # Image from .DNewsImg or check data-src attribute
    img = soup.find('div', class_='DNewsImg')
    if img:
        img = img.find('img')
    if not img:
        img = soup.find('img', attrs={'data-src': True})
    if not img:
        img = soup.find('img')
    
    if img:
        # Check data-src first (lazy loading), then src
        image_url = img.get('data-src') or img.get('src')
        if image_url:
            image_name = os.path.basename(image_url)
    
    return headline, content, image_name

def extract_sangbad(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1 with fallback to h2.title
    h = soup.find('h1')
    if not h:
        h = soup.find('h2', class_='title')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from article-content, content, or article tags
    content_selectors = [
        ('div', {'class': 'article-content'}),
        ('div', {'class': 'content'}),
        ('article', {})
    ]
    for tag, attrs in content_selectors:
        c = soup.find(tag, attrs)
        if c:
            # Remove scripts and styles
            for script in c(['script', 'style', 'iframe']):
                script.decompose()
            paragraphs = c.find_all('p')
            if paragraphs:
                content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
                if content:
                    break
    
    # If no content found, try to get all p tags
    if not content:
        paragraphs = soup.find_all('p')
        content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
    
    # Image from img with /images/.*/main_image/ pattern or og:image
    img = soup.find('img', src=True)
    if img:
        src = img.get('src', '')
        if '/images/' in src and 'main_image' in src:
            image_name = os.path.basename(src)
    
    # Fallback to og:image
    if not image_name:
        og_image = soup.find('meta', property='og:image')
        if og_image and og_image.get('content'):
            image_name = os.path.basename(og_image['content'])
    
    return headline, content, image_name

def extract_amadershomoy(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1 or meta og:title
    h = soup.find('h1')
    if not h:
        meta_title = soup.find('meta', property='og:title')
        if meta_title:
            headline = meta_title.get('content', '').strip()
    else:
        headline = h.get_text(strip=True)
    
    # Content from article tags or paragraph collection
    article_div = soup.find('article')
    if article_div:
        # Remove scripts, styles, and images
        for tag in article_div(['script', 'style', 'img', 'iframe']):
            tag.decompose()
        paragraphs = article_div.find_all('p')
        if paragraphs:
            content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
    
    # Fallback: get all p tags from body
    if not content:
        paragraphs = soup.find_all('p')
        content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
    
    # Image from og:image or first img tag
    og_image = soup.find('meta', property='og:image')
    if og_image and og_image.get('content'):
        image_name = os.path.basename(og_image['content'])
    else:
        img = soup.find('img', src=True)
        if img:
            image_name = os.path.basename(img.get('src', ''))
    
    return headline, content, image_name

def extract_bdpratidin(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1.card-title or just h1
    h = soup.find('h1', class_='card-title')
    if not h:
        h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from article tag
    article_tag = soup.find('article')
    if article_tag:
        for tag in article_tag(['script', 'style', 'img', 'iframe']):
            tag.decompose()
        paragraphs = article_tag.find_all('p')
        if paragraphs:
            content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
    
    # Image from og:image (remove /og/ path if present)
    og_image = soup.find('meta', property='og:image')
    if og_image and og_image.get('content'):
        img_url = og_image['content']
        if '/og/' in img_url:
            img_url = img_url.replace('/og/', '/')
        image_name = os.path.basename(img_url)
    
    return headline, content, image_name

def extract_mzamin(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1 or h2.title
    h = soup.find('h1')
    if not h:
        h = soup.find('h2', class_='title')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from article-content, article tag, or content div
    article_containers = [
        soup.find('div', class_='article-content'),
        soup.find('article'),
        soup.find('div', class_='content'),
    ]
    
    for container in article_containers:
        if container:
            for tag in container(['script', 'style', 'img', 'iframe']):
                tag.decompose()
            paragraphs = container.find_all('p')
            if paragraphs:
                content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
                break
    
    # Image from og:image or article-image class
    og_image = soup.find('meta', property='og:image')
    if og_image and og_image.get('content'):
        image_name = os.path.basename(og_image['content'])
    else:
        img = soup.find('img', class_='article-image')
        if not img:
            img = soup.find('img')
        if img and img.get('src'):
            image_name = os.path.basename(img['src'])
    
    return headline, content, image_name

def extract_dhakatribune(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1.title or h1
    h = soup.find('h1', class_='title')
    if not h:
        h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from article.jw_detail_content_holder or article tag
    article_containers = [
        soup.find('article', class_='jw_detail_content_holder'),
        soup.find('div', class_='content_detail_each_group'),
        soup.find('article'),
    ]
    
    for container in article_containers:
        if container:
            for tag in container(['script', 'style', 'img', 'iframe']):
                tag.decompose()
            paragraphs = container.find_all('p')
            if paragraphs:
                content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
                break
    
    # Image from og:image
    og_image = soup.find('meta', property='og:image')
    if og_image and og_image.get('content'):
        image_name = os.path.basename(og_image['content'])
    
    return headline, content, image_name

def extract_janakantha(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''
    
    # Headline from h1
    h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)
    
    # Content from article.DDetailsContent or article tag
    article_containers = [
        soup.find('article', class_='DDetailsContent'),
        soup.find('article'),
    ]
    
    for container in article_containers:
        if container:
            for tag in container(['script', 'style', 'img', 'iframe']):
                tag.decompose()
            paragraphs = container.find_all('p')
            if paragraphs:
                content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])
                break
    
    # Image from img.TopImg or og:image
    img = soup.find('img', class_='TopImg')
    if img and img.get('src'):
        image_name = os.path.basename(img['src'])
    else:
        og_image = soup.find('meta', property='og:image')
        if og_image and og_image.get('content'):
            image_name = os.path.basename(og_image['content'])
    
    return headline, content, image_name

def extract_boishakhi(html):
    soup = BeautifulSoup(html, 'html.parser')
    headline = ''
    content = ''
    image_name = ''

    # Headline from h1
    h = soup.find('h1')
    if h:
        headline = h.get_text(strip=True)

    # Content from div.dtl_content_section
    content_div = soup.find('div', class_='dtl_content_section')
    if content_div:
        for tag in content_div(['script', 'style', 'img', 'iframe']):
            tag.decompose()
        paragraphs = content_div.find_all('p')
        if paragraphs:
            content = ' '.join([p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True) and len(p.get_text(strip=True)) > 30])

    # Image from div.dtl_img_section or og:image
    dtl_img_div = soup.find('div', class_='dtl_img_section')
    if dtl_img_div:
        img = dtl_img_div.find('img')
        if img and img.get('src'):
            image_name = os.path.basename(img['src'])
    if not image_name:
        og_image = soup.find('meta', property='og:image')
        if og_image and og_image.get('content'):
            image_name = os.path.basename(og_image['content'])

    return headline, content, image_name

# =============== MAIN RECHECKER ===============
def fetch_article_html(url, source_site=''):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
    }
    try:
        if 'kalbela' in source_site:
            resp = kalbela_session.get(url, timeout=15)
        else:
            resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            return resp.text
    except Exception as e:
        print(f"Error fetching {url}: {e}")
    return None

def normalize(text):
    if not text:
        return ''
    return ' '.join(text.split())

def recheck_articles():
    articles = db.get_all_articles()
    updated_count = 0
    total = len(articles)
    for idx, article in enumerate(articles, 1):
        url = article['source_url']
        print(f"PROGRESS {idx} {total}", flush=True)
        source_site = (article.get('source_site') or '').lower()
        html = fetch_article_html(url, source_site)
        if not html:
            print(f"Failed to fetch HTML for article {article['id']} from {source_site}")
            continue
        if 'kalbela' in source_site:
            new_headline, new_content, new_image_name = extract_kalbela(html)
        elif 'desh' in source_site:
            new_headline, new_content, new_image_name = extract_desh(html)
        elif 'jugantor' in source_site:
            new_headline, new_content, new_image_name = extract_jugantor(html)
        elif 'ittefaq' in source_site:
            new_headline, new_content, new_image_name = extract_ittefaq(html)
        elif 'bdnews24' in source_site:
            new_headline, new_content, new_image_name = extract_bdnews24(html)
        elif 'prothomalo' in source_site:
            new_headline, new_content, new_image_name = extract_prothomalo(html)
        elif 'dhakapost' in source_site:
            new_headline, new_content, new_image_name = extract_dhakapost(html)
        elif 'jagonews24' in source_site:
            new_headline, new_content, new_image_name = extract_jagonews24(html)
        elif 'samakal' in source_site:
            new_headline, new_content, new_image_name = extract_samakal(html)
        elif 'sangbad' in source_site:
            new_headline, new_content, new_image_name = extract_sangbad(html)
        elif 'amadershomoy' in source_site:
            new_headline, new_content, new_image_name = extract_amadershomoy(html)
        elif 'bdpratidin' in source_site or 'bd-pratidin' in source_site:
            new_headline, new_content, new_image_name = extract_bdpratidin(html)
        elif 'mzamin' in source_site:
            new_headline, new_content, new_image_name = extract_mzamin(html)
        elif 'dhakatribune' in source_site:
            new_headline, new_content, new_image_name = extract_dhakatribune(html)
        elif 'janakantha' in source_site:
            new_headline, new_content, new_image_name = extract_janakantha(html)
        elif 'boishakhi' in source_site:
            new_headline, new_content, new_image_name = extract_boishakhi(html)
        else:
            print(f"No extractor for source_site: '{source_site}' (article {article['id']})")
            continue
        changed = False
        old_headline = normalize(article['headline'])
        old_content = normalize(article['content'])
        old_image_name = article['image_name'] or ''  # Keep original, don't normalize
        new_headline_n = normalize(new_headline)
        new_content_n = normalize(new_content)

        if new_headline_n and new_headline_n != old_headline:
            print(f"Headline changed: {old_headline[:50]} -> {new_headline_n[:50]}")
            changed = True
        if new_content_n and new_content_n != old_content:
            print(f"Content changed for article {article['id']}")
            changed = True

        # NOTE: We do NOT update image_name during recheck because:
        # 1. Images are already downloaded locally with names like "dhakapost_xxxxx.jpg"
        # 2. The extracted image_name from HTML is just the CDN basename, not the local file
        # 3. Updating would break the link between DB and local files

        if changed:
            # For kalbela, store normalized values so subsequent rechecks
            # don't falsely detect changes from whitespace/formatting differences
            if 'kalbela' in source_site:
                store_headline = new_headline_n if new_headline_n else article['headline']
                store_content = new_content_n if new_content_n else article['content']
            else:
                store_headline = new_headline
                store_content = new_content
            db.update_article_on_recheck(
                article['id'], store_headline, store_content,
                old_image_name  # Keep original image_name
            )
            updated_count += 1
    print(f"Recheck complete. {updated_count} articles updated.")

if __name__ == "__main__":
    # Ensure DB schema (including 'update' column) exists before running
    db.ensure_schema()
    recheck_articles()
