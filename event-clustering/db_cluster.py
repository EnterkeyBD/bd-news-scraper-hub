"""
Database module for Event Clustering System
Handles storage of article embeddings and event clusters
"""

import mysql.connector
from mysql.connector import errorcode
from datetime import datetime
from typing import Optional, Dict, List, Tuple

DB_INFO_FILE = "READ ME DB.txt"

def parse_db_info(path=DB_INFO_FILE):
    """Return DB connection info. Uses provided credentials; ignores local file."""
    return {
        'host': "103.213.38.238",
        'port': 3306,
        'database': "siamvidb_scraptestg",
        'user': "siamvidb_scraptestg",
        'password': "HuHmf!w=E]%I=3L&"
    }


def get_connection():
    """Get database connection with utf8mb4 charset for Bengali support"""
    cfg = parse_db_info()
    conn = mysql.connector.connect(
        host=cfg['host'],
        port=cfg['port'],
        user=cfg['user'],
        password=cfg['password'],
        database=cfg['database'],
        charset='utf8mb4'
    )
    return conn


def create_clustering_tables():
    """
    Create tables for event clustering system:
    1. article_embeddings: Stores semantic embeddings for each article
    2. event_clusters: Stores information about each event cluster
    3. cluster_members: Links articles to their clusters
    """
    
    # Store semantic embeddings for articles
    create_embeddings_sql = (
        "CREATE TABLE IF NOT EXISTS article_embeddings ("
        "id INT AUTO_INCREMENT PRIMARY KEY,"
        "article_id INT NOT NULL,"
        "embedding BLOB NOT NULL,"  # Store as binary (pickled numpy array or json)
        "embedding_model VARCHAR(100) NOT NULL,"
        "text_hash VARCHAR(64) NOT NULL,"  # MD5/SHA256 of headline+content to detect changes
        "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
        "UNIQUE KEY ux_article_id (article_id),"
        "INDEX idx_embedding_model (embedding_model),"
        "INDEX idx_text_hash (text_hash),"
        "FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    )
    
    # Store event cluster information
    create_clusters_sql = (
        "CREATE TABLE IF NOT EXISTS event_clusters ("
        "id INT AUTO_INCREMENT PRIMARY KEY,"
        "cluster_name VARCHAR(255),"  # Auto-generated descriptive name
        "primary_article_id INT,"  # The most detailed/comprehensive article
        "article_count INT DEFAULT 0,"
        "avg_similarity FLOAT,"  # Average similarity score within cluster
        "event_date DATE,"  # Date of the event (from earliest article)
        "category VARCHAR(255),"  # Primary category of the event
        "tags TEXT,"  # Combined tags from all articles
        "status VARCHAR(50) DEFAULT 'active',"  # active, archived, merged
        "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
        "INDEX idx_event_date (event_date),"
        "INDEX idx_status (status),"
        "INDEX idx_category (category),"
        "INDEX idx_primary_article (primary_article_id),"
        "FOREIGN KEY (primary_article_id) REFERENCES articles(id) ON DELETE SET NULL"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    )
    
    # Link articles to clusters
    create_members_sql = (
        "CREATE TABLE IF NOT EXISTS cluster_members ("
        "id INT AUTO_INCREMENT PRIMARY KEY,"
        "cluster_id INT NOT NULL,"
        "article_id INT NOT NULL,"
        "similarity_to_primary FLOAT,"  # Similarity to the primary article
        "content_length INT,"  # Word count for ranking
        "source_site VARCHAR(255),"  # Redundant but useful for quick queries
        "is_primary BOOLEAN DEFAULT FALSE,"
        "added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "UNIQUE KEY ux_cluster_article (cluster_id, article_id),"
        "INDEX idx_cluster_id (cluster_id),"
        "INDEX idx_article_id (article_id),"
        "INDEX idx_is_primary (is_primary),"
        "FOREIGN KEY (cluster_id) REFERENCES event_clusters(id) ON DELETE CASCADE,"
        "FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    )
    
    # Clustering history for tracking runs
    create_history_sql = (
        "CREATE TABLE IF NOT EXISTS clustering_history ("
        "id INT AUTO_INCREMENT PRIMARY KEY,"
        "run_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "articles_processed INT,"
        "clusters_created INT,"
        "clusters_updated INT,"
        "time_window_hours INT,"
        "similarity_threshold FLOAT,"
        "model_used VARCHAR(100),"
        "execution_time_seconds FLOAT,"
        "status VARCHAR(50),"
        "notes TEXT,"
        "INDEX idx_run_date (run_date),"
        "INDEX idx_status (status)"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    )
    
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        print("Creating article_embeddings table...")
        cur.execute(create_embeddings_sql)
        
        print("Creating event_clusters table...")
        cur.execute(create_clusters_sql)
        
        print("Creating cluster_members table...")
        cur.execute(create_members_sql)
        
        print("Creating clustering_history table...")
        cur.execute(create_history_sql)
        
        conn.commit()
        print("✓ All clustering tables created successfully!")
        
    except mysql.connector.Error as err:
        if err.errno == errorcode.ER_ACCESS_DENIED_ERROR:
            print("Database access denied. Check credentials.")
        elif err.errno == errorcode.ER_BAD_DB_ERROR:
            print("Database does not exist.")
        else:
            print(f"Error creating tables: {err}")
        if conn:
            conn.rollback()
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def store_embedding(article_id: int, embedding: bytes, model: str, text_hash: str) -> bool:
    """Store article embedding in database"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        sql = """
            INSERT INTO article_embeddings (article_id, embedding, embedding_model, text_hash)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                embedding = VALUES(embedding),
                embedding_model = VALUES(embedding_model),
                text_hash = VALUES(text_hash),
                updated_at = CURRENT_TIMESTAMP
        """
        cur.execute(sql, (article_id, embedding, model, text_hash))
        conn.commit()
        return True
        
    except mysql.connector.Error as err:
        print(f"Error storing embedding for article {article_id}: {err}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def get_articles_in_timewindow(hours: int = 24, limit: Optional[int] = None) -> List[Dict]:
    """
    Get articles published within the last N hours
    Returns: List of dicts with id, headline, content, published_at, source_site
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)
        
        sql = """
            SELECT id, headline, actual_headline, content, published_at, 
                   source_site, category, tags, CHAR_LENGTH(content) as content_length
            FROM articles
            WHERE published_at >= DATE_SUB(NOW(), INTERVAL %s HOUR)
            AND content IS NOT NULL
            AND headline IS NOT NULL
            ORDER BY published_at DESC
        """
        
        if limit:
            sql += f" LIMIT {limit}"
        
        cur.execute(sql, (hours,))
        articles = cur.fetchall()
        return articles
        
    except mysql.connector.Error as err:
        print(f"Error fetching articles: {err}")
        return []
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def get_articles_without_embeddings(model: str, limit: Optional[int] = None) -> List[Dict]:
    """Get articles that don't have embeddings yet for the specified model"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)
        
        sql = """
            SELECT a.id, a.headline, a.actual_headline, a.content, a.published_at,
                   a.source_site, a.category, a.tags, CHAR_LENGTH(a.content) as content_length
            FROM articles a
            LEFT JOIN article_embeddings ae ON a.article_id = ae.article_id AND ae.embedding_model = %s
            WHERE ae.id IS NULL
            AND a.content IS NOT NULL
            AND a.headline IS NOT NULL
            ORDER BY a.published_at DESC
        """
        
        if limit:
            sql += f" LIMIT {limit}"
        
        cur.execute(sql, (model,))
        articles = cur.fetchall()
        return articles
        
    except mysql.connector.Error as err:
        print(f"Error fetching articles without embeddings: {err}")
        return []
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def create_cluster(primary_article_id: int, cluster_name: str, event_date: str, 
                   category: str, tags: str = "") -> Optional[int]:
    """Create a new event cluster"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        sql = """
            INSERT INTO event_clusters 
            (primary_article_id, cluster_name, event_date, category, tags, article_count)
            VALUES (%s, %s, %s, %s, %s, 1)
        """
        cur.execute(sql, (primary_article_id, cluster_name, event_date, category, tags))
        conn.commit()
        
        return cur.lastrowid
        
    except mysql.connector.Error as err:
        print(f"Error creating cluster: {err}")
        if conn:
            conn.rollback()
        return None
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def add_article_to_cluster(cluster_id: int, article_id: int, similarity: float,
                           content_length: int, source_site: str, is_primary: bool = False) -> bool:
    """Add an article to a cluster"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        # Insert into cluster_members
        sql_member = """
            INSERT INTO cluster_members 
            (cluster_id, article_id, similarity_to_primary, content_length, source_site, is_primary)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                similarity_to_primary = VALUES(similarity_to_primary),
                content_length = VALUES(content_length),
                is_primary = VALUES(is_primary)
        """
        cur.execute(sql_member, (cluster_id, article_id, similarity, content_length, source_site, is_primary))
        
        # Update cluster article count
        sql_update = """
            UPDATE event_clusters
            SET article_count = (
                SELECT COUNT(*) FROM cluster_members WHERE cluster_id = %s
            ),
            updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """
        cur.execute(sql_update, (cluster_id, cluster_id))
        
        conn.commit()
        return True
        
    except mysql.connector.Error as err:
        print(f"Error adding article to cluster: {err}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def update_cluster_primary(cluster_id: int, new_primary_id: int) -> bool:
    """Update the primary article of a cluster (when a more detailed article is found)"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        # Remove primary flag from all articles in cluster
        cur.execute("""
            UPDATE cluster_members 
            SET is_primary = FALSE 
            WHERE cluster_id = %s
        """, (cluster_id,))
        
        # Set new primary
        cur.execute("""
            UPDATE cluster_members 
            SET is_primary = TRUE 
            WHERE cluster_id = %s AND article_id = %s
        """, (cluster_id, new_primary_id))
        
        # Update cluster table
        cur.execute("""
            UPDATE event_clusters 
            SET primary_article_id = %s, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (new_primary_id, cluster_id))
        
        conn.commit()
        return True
        
    except mysql.connector.Error as err:
        print(f"Error updating cluster primary: {err}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def get_cluster_details(cluster_id: int) -> Optional[Dict]:
    """Get detailed information about a cluster including all member articles"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)
        
        # Get cluster info
        cur.execute("""
            SELECT c.*, a.headline as primary_headline, a.source_site as primary_source
            FROM event_clusters c
            LEFT JOIN articles a ON c.primary_article_id = a.id
            WHERE c.id = %s
        """, (cluster_id,))
        cluster = cur.fetchone()
        
        if not cluster:
            return None
        
        # Get all member articles
        cur.execute("""
            SELECT cm.*, a.headline, a.actual_headline, a.published_at, a.content,
                   a.source_url, a.category
            FROM cluster_members cm
            JOIN articles a ON cm.article_id = a.id
            WHERE cm.cluster_id = %s
            ORDER BY cm.is_primary DESC, cm.content_length DESC
        """, (cluster_id,))
        cluster['members'] = cur.fetchall()
        
        return cluster
        
    except mysql.connector.Error as err:
        print(f"Error getting cluster details: {err}")
        return None
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def clear_all_clusters() -> bool:
    """
    Clear all clustering data to prevent duplicates on re-run.
    Deletes all records from event_clusters, cluster_members, and article_embeddings.
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        # Delete in proper order (foreign key constraints)
        cur.execute("DELETE FROM cluster_members")
        cur.execute("DELETE FROM event_clusters")
        cur.execute("DELETE FROM article_embeddings")
        
        conn.commit()
        return True
        
    except mysql.connector.Error as err:
        print(f"Error clearing clusters: {err}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


def log_clustering_run(articles_processed: int, clusters_created: int, clusters_updated: int,
                      time_window_hours: int, similarity_threshold: float, model_used: str,
                      execution_time: float, status: str, notes: str = "") -> bool:
    """Log a clustering run to history"""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        sql = """
            INSERT INTO clustering_history 
            (articles_processed, clusters_created, clusters_updated, time_window_hours,
             similarity_threshold, model_used, execution_time_seconds, status, notes)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        cur.execute(sql, (articles_processed, clusters_created, clusters_updated, 
                         time_window_hours, similarity_threshold, model_used,
                         execution_time, status, notes))
        conn.commit()
        return True
        
    except mysql.connector.Error as err:
        print(f"Error logging clustering run: {err}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn and conn.is_connected():
            cur.close()
            conn.close()


if __name__ == "__main__":
    print("Creating event clustering tables...")
    create_clustering_tables()
