# Event Clustering System

Automatically identify and cluster news articles about the same event from different sources using AI-powered semantic similarity.

## Overview

This system analyzes articles from multiple Bengali news sources (Jugantor, Kalbela, Prothom Alo, etc.) and groups articles that report on the same event, even when they're written differently. It helps identify:

- **Duplicate coverage** across news sources
- **The most comprehensive article** for each event
- **Related articles** that provide different perspectives

## How It Works

### 3-Layer Filtering Approach

1. **Time Window Filter** (Fast)
   - Only compares articles published within ±12-24 hours
   - Dramatically reduces comparison space

2. **Semantic Similarity** (Core AI)
   - Uses multilingual sentence-transformer model (`paraphrase-multilingual-MiniLM-L12-v2`)
   - Supports Bengali text natively
   - Generates 384-dimensional embeddings for each article
   - Computes cosine similarity between embeddings
   - Threshold: 0.75+ similarity = same event

3. **Clustering & Ranking**
   - Groups similar articles using DBSCAN algorithm
   - Ranks articles by content length
   - Selects the most detailed article as "primary"

## Example Output

```
Event Cluster #142: "ঢাকায় বন্যা পরিস্থিতি"
├── jugantor    - 1200 words ⭐ (most detailed)  
├── kalbela     - 800 words
├── prothomalo  - 950 words
├── desh        - 600 words
└── bdnews24    - 700 words
```

## Installation

### 1. Install Dependencies

```bash
cd event-clustering
pip install sentence-transformers scikit-learn rich
```

Or use the automated setup:

```bash
python start.py
```

### 2. Create Database Tables

```bash
python db_cluster.py
```

This creates 4 new tables:
- `article_embeddings` - Stores AI-generated embeddings
- `event_clusters` - Cluster metadata
- `cluster_members` - Article-to-cluster mappings
- `clustering_history` - Run logs

## Usage

### Quick Start (Automated)

```bash
python start.py
```

This will:
1. Check/install dependencies
2. Set up database tables
3. Run initial clustering on last 24 hours of articles

### Manual Usage

#### Run Clustering

```bash
# Cluster articles from last 24 hours
python cluster_service.py --hours 24 --threshold 0.75

# Cluster last 48 hours with stricter threshold
python cluster_service.py --hours 48 --threshold 0.80

# Test mode (limit to 100 articles)
python cluster_service.py --hours 24 --max-articles 100
```

**Arguments:**
- `--hours` - Time window in hours (default: 24)
- `--threshold` - Similarity threshold 0-1 (default: 0.75)
- `--max-articles` - Limit articles for testing
- `--model` - Transformer model name

#### View Clusters

```bash
# Show statistics
python view_clusters.py --stats

# List all clusters
python view_clusters.py --list

# View specific cluster details
python view_clusters.py --detail 123

# Search clusters
python view_clusters.py --search "বন্যা"

# Show clustering history
python view_clusters.py --history
```

## Database Schema

### article_embeddings
Stores semantic embeddings for each article.
```sql
- article_id (FK to articles.id)
- embedding (BLOB) - Pickled numpy array
- embedding_model (VARCHAR) - Model used
- text_hash (VARCHAR) - For change detection
```

### event_clusters
Metadata about each event cluster.
```sql
- id (Primary Key)
- cluster_name (VARCHAR) - Descriptive name
- primary_article_id (FK) - Most detailed article
- article_count (INT)
- event_date (DATE)
- category (VARCHAR)
- status (VARCHAR) - active/archived
```

### cluster_members
Links articles to clusters.
```sql
- cluster_id (FK to event_clusters)
- article_id (FK to articles)
- similarity_to_primary (FLOAT)
- content_length (INT)
- is_primary (BOOLEAN)
```

## Configuration

### Similarity Threshold

Adjust based on desired precision/recall:

- **0.70** - More clusters, some false positives
- **0.75** - Balanced (recommended)
- **0.80** - Stricter, fewer false positives
- **0.85** - Very strict, may miss related articles

### Time Window

- **12 hours** - Breaking news, fast-moving events
- **24 hours** - Standard daily news (recommended)
- **48 hours** - Weekend/slower news cycles
- **72+ hours** - Special investigations, analysis pieces

### Model Selection

Current: `paraphrase-multilingual-MiniLM-L12-v2`
- **Pros**: Fast, supports Bengali, 384-dim embeddings
- **Cons**: Less accurate than larger models

Alternatives:
- `sentence-transformers/LaBSE` - Better multilingual, 768-dim
- `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` - Higher quality, slower

## Performance

### First Run
- Downloads ML model (~120MB)
- Takes 2-3 minutes for 1000 articles
- Generates and stores embeddings

### Subsequent Runs
- Model cached locally
- Only processes new articles
- ~1 minute for 1000 articles

### Resource Usage
- RAM: ~500MB (model + embeddings)
- Disk: ~100MB (model) + ~1KB per article (embedding)

## Integration with Scraper Manager

### Automated Scheduling

Add to scraper-manager to run automatically:

```javascript
// In server.js
const { exec } = require('child_process');

// Run clustering every 6 hours
setInterval(() => {
  exec('python ../event-clustering/cluster_service.py --hours 24', 
    (error, stdout, stderr) => {
      console.log('Clustering completed:', stdout);
  });
}, 6 * 60 * 60 * 1000);
```

### Manual Trigger

Add a button in the dashboard:

```javascript
app.post('/api/cluster/run', (req, res) => {
  exec('python ../event-clustering/cluster_service.py --hours 24',
    (error, stdout, stderr) => {
      if (error) {
        res.json({ success: false, error: stderr });
      } else {
        res.json({ success: true, output: stdout });
      }
  });
});
```

## API Functions

### cluster_service.py

```python
from cluster_service import EventClusteringService

# Initialize
service = EventClusteringService(
    similarity_threshold=0.75,
    time_window_hours=24
)

# Run clustering
stats = service.run_clustering()

# Generate embedding for single article
text = "article_headline\n\narticle_content"
embedding = service.generate_embedding(text)
```

### db_cluster.py

```python
import db_cluster as db

# Get cluster details
cluster = db.get_cluster_details(cluster_id=123)

# Get recent articles
articles = db.get_articles_in_timewindow(hours=24)

# Create new cluster
cluster_id = db.create_cluster(
    primary_article_id=456,
    cluster_name="Event Name",
    event_date="2024-01-15",
    category="National"
)
```

## Troubleshooting

### Model Download Fails
```bash
# Manual download
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')"
```

### Memory Issues
- Reduce batch size in `generate_embeddings_batch()`
- Use `--max-articles` to limit processing

### Slow Performance
- Check database indices are created
- Reduce time window
- Use faster model

### No Clusters Created
- Lower similarity threshold (try 0.70)
- Increase time window
- Check if articles have content

## Future Enhancements

- [ ] Incremental clustering (only new articles)
- [ ] Cross-language clustering (Bengali + English)
- [ ] Auto-generated summaries for clusters
- [ ] Trend detection (rising events)
- [ ] Integration with face search
- [ ] REST API for external access
- [ ] Real-time clustering as articles are scraped
- [ ] Cluster merging/splitting tools
- [ ] Quality scoring for articles

## Technical Details

### Embedding Generation
- Input: Headline + first 500 chars of content
- Model: `paraphrase-multilingual-MiniLM-L12-v2`
- Output: 384-dimensional float vector
- Storage: Pickled numpy array as BLOB

### Clustering Algorithm
- Method: DBSCAN (Density-Based Spatial Clustering)
- Distance metric: Cosine distance (1 - cosine similarity)
- Min samples: 2 (minimum cluster size)
- Noise points: Ignored (articles with no similar matches)

### Similarity Calculation
```python
similarity = cosine_similarity(embedding1, embedding2)
# Range: -1 (opposite) to 1 (identical)
# Typical same-event range: 0.75 - 0.95
```

## Support

For issues or questions:
1. Check clustering history: `python view_clusters.py --history`
2. Review logs in `clustering_history` table
3. Test with small dataset: `--max-articles 50`

## License

Part of the Multi Scraper v11 X project.
