"""
Get clustering statistics as JSON for API integration
"""

import json
import sys
import db_cluster as db
from datetime import datetime

# Fix encoding for Windows console
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def get_stats():
    """Get clustering statistics"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        # Total active clusters
        cur.execute("SELECT COUNT(*) as total FROM event_clusters WHERE status='active'")
        total_clusters = cur.fetchone()['total']
        
        # Average articles per cluster
        cur.execute("""
            SELECT AVG(article_count) as avg_articles
            FROM event_clusters
            WHERE status='active'
        """)
        avg_articles = cur.fetchone()['avg_articles'] or 0
        
        # Total articles in clusters
        cur.execute("""
            SELECT COUNT(DISTINCT article_id) as total
            FROM cluster_members cm
            JOIN event_clusters ec ON cm.cluster_id = ec.id
            WHERE ec.status='active'
        """)
        total_clustered_articles = cur.fetchone()['total']
        
        # Last clustering run
        cur.execute("""
            SELECT run_date, articles_processed, clusters_created, execution_time_seconds
            FROM clustering_history
            ORDER BY run_date DESC
            LIMIT 1
        """)
        last_run = cur.fetchone()
        
        # Clusters by category (top 5)
        cur.execute("""
            SELECT category, COUNT(*) as count
            FROM event_clusters
            WHERE status='active'
            GROUP BY category
            ORDER BY count DESC
            LIMIT 5
        """)
        by_category = cur.fetchall()
        
        # Recent clusters (created in last 24 hours)
        cur.execute("""
            SELECT COUNT(*) as count
            FROM event_clusters
            WHERE status='active' 
            AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        """)
        recent_clusters = cur.fetchone()['count']
        
        stats = {
            'total_clusters': total_clusters,
            'avg_articles': float(avg_articles),
            'total_clustered_articles': total_clustered_articles,
            'recent_clusters_24h': recent_clusters,
            'last_run': {
                'date': str(last_run['run_date']) if last_run else None,
                'articles_processed': last_run['articles_processed'] if last_run else 0,
                'clusters_created': last_run['clusters_created'] if last_run else 0,
                'execution_time': float(last_run['execution_time_seconds']) if last_run else 0
            },
            'by_category': [
                {'category': row['category'], 'count': row['count']}
                for row in by_category
            ]
        }
        
        return stats
        
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    try:
        stats = get_stats()
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
