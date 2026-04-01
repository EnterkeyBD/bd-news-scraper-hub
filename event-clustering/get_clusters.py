"""
Get cluster list as JSON for API integration
"""

import json
import sys
import argparse
import db_cluster as db

# Fix encoding for Windows console
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def get_clusters(limit=50, offset=0):
    """Get list of clusters"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT c.id, c.cluster_name as name, c.article_count, c.event_date, 
                   c.category, c.created_at, a.source_site as primary_source
            FROM event_clusters c
            LEFT JOIN articles a ON c.primary_article_id = a.id
            WHERE c.status = 'active'
            ORDER BY c.event_date DESC, c.created_at DESC
            LIMIT %s OFFSET %s
        """, (limit, offset))
        
        clusters = cur.fetchall()
        
        # Convert dates to strings
        for cluster in clusters:
            if cluster['event_date']:
                cluster['event_date'] = str(cluster['event_date'])
            if cluster['created_at']:
                cluster['created_at'] = str(cluster['created_at'])
        
        return clusters
        
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=50)
    parser.add_argument('--offset', type=int, default=0)
    args = parser.parse_args()
    
    try:
        clusters = get_clusters(args.limit, args.offset)
        print(json.dumps(clusters, indent=2, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
