"""
Configuration for Event Clustering System
"""

# Database connection (uses same DB as scrapers)
DB_CONFIG = {
    'host': "103.213.38.238",
    'port': 3306,
    'database': "siamvidb_scraptestg",
    'user': "siamvidb_scraptestg",
    'password': "HuHmf!w=E]%I=3L&"
}

# Clustering parameters
CLUSTERING_CONFIG = {
    # Sentence transformer model
    # Options:
    #   - paraphrase-multilingual-MiniLM-L12-v2 (fast, 384-dim, NOT GOOD for Bengali)
    #   - sentence-transformers/LaBSE (RECOMMENDED: 768-dim, best for Bengali)
    #   - sentence-transformers/paraphrase-multilingual-mpnet-base-v2 (highest accuracy, 768-dim, slower)
    'model_name': 'sentence-transformers/LaBSE',
    
    # Cosine similarity threshold (0-1)
    # Higher = stricter matching
    # With LaBSE (better Bengali understanding):
    # 0.82 = recommended (aligns with DBSCAN threshold, balanced)
    # 0.85 = stricter (may miss some valid clusters)
    # 0.90 = very strict
    'similarity_threshold': 0.82,
    
    # Time window for comparison (hours)
    'time_window_hours': 24,
    
    # Batch size for embedding generation
    'batch_size': 32,
    
    # Minimum articles required for a cluster
    'min_cluster_size': 2,
}

# Scheduling (for automated runs)
SCHEDULE_CONFIG = {
    # Run clustering every N hours
    'interval_hours': 6,
    
    # Run at specific times (24-hour format)
    'run_at_hours': [0, 6, 12, 18],  # Midnight, 6am, noon, 6pm
}

# Performance tuning
PERFORMANCE_CONFIG = {
    # Maximum articles to process in one run (None = no limit)
    'max_articles_per_run': None,
    
    # Cache embeddings in memory
    'cache_embeddings': True,
    
    # Number of parallel workers for embedding generation
    'num_workers': 4,
}

# Logging
LOGGING_CONFIG = {
    'log_level': 'INFO',  # DEBUG, INFO, WARNING, ERROR
    'log_file': 'logs/clustering.log',
    'console_output': True,
}

# Advanced options
ADVANCED_CONFIG = {
    # Clustering algorithm
    # Options: 'dbscan', 'hierarchical', 'kmeans'
    'clustering_algorithm': 'dbscan',
    
    # DBSCAN specific parameters
    'dbscan': {
        'min_samples': 2,  # Minimum cluster size
        'metric': 'cosine',
    },
    
    # Auto-merge similar clusters
    'auto_merge_clusters': False,
    'merge_threshold': 0.85,
    
    # Primary article selection criteria
    # Options: 'length', 'quality', 'source_priority'
    'primary_selection_method': 'length',
    
    # Source priority (higher = preferred for primary)
    'source_priority': {
        'prothomalo': 10,
        'bdnews24': 9,
        'jugantor': 8,
        'ittefaq': 8,
        'kalbela': 7,
        'dhakapost': 7,
        'desh': 6,
        'jagonews24': 6,
    },
}
