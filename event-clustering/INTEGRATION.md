# Event Clustering Integration with Scraper Manager

## Quick Integration

### Option 1: Manual Button in Dashboard

Add this to `scraper-manager/server.js`:

```javascript
const { exec } = require('child_process');
const path = require('path');

// Clustering endpoint
app.post('/api/clustering/run', (req, res) => {
    const hours = req.body.hours || 24;
    const threshold = req.body.threshold || 0.75;
    
    const clusteringScript = path.join(__dirname, '../event-clustering/cluster_service.py');
    const command = `python "${clusteringScript}" --hours ${hours} --threshold ${threshold}`;
    
    console.log('Running clustering:', command);
    
    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Clustering error:', error);
            res.json({ 
                success: false, 
                error: stderr || error.message 
            });
        } else {
            console.log('Clustering output:', stdout);
            res.json({ 
                success: true, 
                output: stdout,
                message: 'Clustering completed successfully'
            });
        }
    });
});

// Get clustering stats
app.get('/api/clustering/stats', (req, res) => {
    const statsScript = path.join(__dirname, '../event-clustering/get_stats.py');
    
    exec(`python "${statsScript}"`, (error, stdout, stderr) => {
        if (error) {
            res.json({ success: false, error: stderr });
        } else {
            try {
                const stats = JSON.parse(stdout);
                res.json({ success: true, stats });
            } catch (e) {
                res.json({ success: false, error: 'Failed to parse stats' });
            }
        }
    });
});

// Get cluster list
app.get('/api/clustering/clusters', (req, res) => {
    const limit = req.query.limit || 50;
    const listScript = path.join(__dirname, '../event-clustering/get_clusters.py');
    
    exec(`python "${listScript}" --limit ${limit}`, (error, stdout, stderr) => {
        if (error) {
            res.json({ success: false, error: stderr });
        } else {
            try {
                const clusters = JSON.parse(stdout);
                res.json({ success: true, clusters });
            } catch (e) {
                res.json({ success: false, error: 'Failed to parse clusters' });
            }
        }
    });
});

// Get specific cluster details
app.get('/api/clustering/cluster/:id', (req, res) => {
    const clusterId = req.params.id;
    const detailScript = path.join(__dirname, '../event-clustering/get_cluster_detail.py');
    
    exec(`python "${detailScript}" --id ${clusterId}`, (error, stdout, stderr) => {
        if (error) {
            res.json({ success: false, error: stderr });
        } else {
            try {
                const cluster = JSON.parse(stdout);
                res.json({ success: true, cluster });
            } catch (e) {
                res.json({ success: false, error: 'Failed to parse cluster' });
            }
        }
    });
});
```

### Option 2: Automated Scheduling

Add this to `scraper-manager/server.js` for automatic clustering:

```javascript
// Run clustering every 6 hours
const clusteringInterval = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

setInterval(() => {
    const clusteringScript = path.join(__dirname, '../event-clustering/cluster_service.py');
    const command = `python "${clusteringScript}" --hours 24 --threshold 0.75`;
    
    console.log('[Scheduled] Running clustering...');
    
    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            console.error('[Scheduled] Clustering error:', error);
        } else {
            console.log('[Scheduled] Clustering completed:', stdout);
        }
    });
}, clusteringInterval);

// Also run on server start
setTimeout(() => {
    console.log('[Startup] Running initial clustering...');
    const clusteringScript = path.join(__dirname, '../event-clustering/cluster_service.py');
    exec(`python "${clusteringScript}" --hours 24`, (error, stdout) => {
        if (!error) console.log('[Startup] Initial clustering done');
    });
}, 5000); // Wait 5 seconds after server starts
```

### Option 3: Integration with Scrapers

Run clustering after each scraper completes:

```javascript
// In your scraper start/stop handler
app.post('/start-scraper/:site', async (req, res) => {
    const site = req.params.site;
    
    // ... existing scraper start code ...
    
    // After scraper completes, run clustering
    scraperProcess.on('exit', (code) => {
        console.log(`Scraper ${site} finished with code ${code}`);
        
        if (code === 0) {
            // Run clustering on new articles
            const clusteringScript = path.join(__dirname, '../event-clustering/cluster_service.py');
            exec(`python "${clusteringScript}" --hours 2`, (error) => {
                if (!error) {
                    console.log(`Clustering completed for ${site} articles`);
                }
            });
        }
    });
});
```

## Dashboard UI Components

### Add Clustering Button

In `scraper-manager/public/index.html`:

```html
<!-- Add to your dashboard -->
<div class="clustering-section">
    <h2>Event Clustering</h2>
    <div class="clustering-controls">
        <button onclick="runClustering()" class="btn btn-primary">
            <i class="fas fa-project-diagram"></i> Run Clustering
        </button>
        <button onclick="viewClusters()" class="btn btn-secondary">
            <i class="fas fa-list"></i> View Clusters
        </button>
        <button onclick="refreshStats()" class="btn btn-info">
            <i class="fas fa-chart-bar"></i> Show Stats
        </button>
    </div>
    
    <div id="clustering-stats" class="stats-panel">
        <!-- Stats will be populated here -->
    </div>
    
    <div id="clusters-list" class="clusters-panel">
        <!-- Clusters will be populated here -->
    </div>
</div>

<script>
function runClustering() {
    const hours = prompt('Time window in hours:', '24');
    const threshold = prompt('Similarity threshold (0.70-0.90):', '0.75');
    
    if (!hours || !threshold) return;
    
    showLoading('Running clustering...');
    
    fetch('/api/clustering/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            hours: parseInt(hours), 
            threshold: parseFloat(threshold) 
        })
    })
    .then(res => res.json())
    .then(data => {
        hideLoading();
        if (data.success) {
            alert('Clustering completed successfully!');
            refreshStats();
        } else {
            alert('Error: ' + data.error);
        }
    })
    .catch(err => {
        hideLoading();
        alert('Error running clustering: ' + err);
    });
}

function refreshStats() {
    fetch('/api/clustering/stats')
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            displayStats(data.stats);
        }
    });
}

function displayStats(stats) {
    const statsPanel = document.getElementById('clustering-stats');
    statsPanel.innerHTML = `
        <h3>Clustering Statistics</h3>
        <div class="stat-cards">
            <div class="stat-card">
                <div class="stat-value">${stats.total_clusters}</div>
                <div class="stat-label">Total Clusters</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avg_articles.toFixed(1)}</div>
                <div class="stat-label">Avg Articles/Cluster</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.last_run}</div>
                <div class="stat-label">Last Run</div>
            </div>
        </div>
    `;
}

function viewClusters() {
    fetch('/api/clustering/clusters?limit=50')
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            displayClusters(data.clusters);
        }
    });
}

function displayClusters(clusters) {
    const clustersPanel = document.getElementById('clusters-list');
    
    let html = '<h3>Recent Event Clusters</h3><table class="clusters-table"><thead><tr><th>ID</th><th>Event</th><th>Articles</th><th>Date</th><th>Actions</th></tr></thead><tbody>';
    
    clusters.forEach(cluster => {
        html += `
            <tr>
                <td>${cluster.id}</td>
                <td>${cluster.name}</td>
                <td>${cluster.article_count}</td>
                <td>${cluster.event_date}</td>
                <td>
                    <button onclick="viewClusterDetail(${cluster.id})" class="btn-small">
                        View
                    </button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    clustersPanel.innerHTML = html;
}

function viewClusterDetail(clusterId) {
    fetch(`/api/clustering/cluster/${clusterId}`)
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showClusterModal(data.cluster);
        }
    });
}
</script>
```

### CSS Styling

Add to your CSS:

```css
.clustering-section {
    background: white;
    padding: 20px;
    border-radius: 8px;
    margin: 20px 0;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.clustering-controls {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
}

.stats-panel, .clusters-panel {
    margin-top: 20px;
}

.stat-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
    margin-top: 15px;
}

.stat-card {
    background: #f8f9fa;
    padding: 20px;
    border-radius: 6px;
    text-align: center;
}

.stat-value {
    font-size: 32px;
    font-weight: bold;
    color: #007bff;
}

.stat-label {
    font-size: 14px;
    color: #666;
    margin-top: 5px;
}

.clusters-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 15px;
}

.clusters-table th,
.clusters-table td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid #ddd;
}

.clusters-table th {
    background: #f8f9fa;
    font-weight: 600;
}

.btn-small {
    padding: 4px 12px;
    font-size: 12px;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
}

.btn-small:hover {
    background: #0056b3;
}
```

## Command-Line Shortcuts

Create these helper scripts in `scraper-manager/`:

### cluster-now.bat (Windows)
```batch
@echo off
cd ..\event-clustering
python cluster_service.py --hours 24 --threshold 0.75
pause
```

### view-clusters.bat (Windows)
```batch
@echo off
cd ..\event-clustering
python view_clusters.py --list
pause
```

### cluster-stats.bat (Windows)
```batch
@echo off
cd ..\event-clustering
python view_clusters.py --stats
pause
```

## Testing

1. **Setup:**
   ```bash
   cd event-clustering
   python start.py
   ```

2. **Run first clustering:**
   ```bash
   python cluster_service.py --hours 24 --max-articles 100
   ```

3. **View results:**
   ```bash
   python view_clusters.py --list
   ```

4. **Test API integration:**
   ```bash
   curl -X POST http://localhost:3000/api/clustering/run -H "Content-Type: application/json" -d "{\"hours\":24,\"threshold\":0.75}"
   ```

## Monitoring

Watch clustering logs:
```sql
SELECT * FROM clustering_history ORDER BY run_date DESC LIMIT 10;
```

Check cluster quality:
```sql
SELECT 
    AVG(article_count) as avg_size,
    AVG(avg_similarity) as avg_sim,
    COUNT(*) as total_clusters
FROM event_clusters 
WHERE status='active';
```

## Troubleshooting

If clustering doesn't work:
1. Check Python dependencies: `pip list | findstr sentence`
2. Check database connection: `python db_cluster.py`
3. Test with small dataset: `--max-articles 50`
4. Check logs: `python view_clusters.py --history`
