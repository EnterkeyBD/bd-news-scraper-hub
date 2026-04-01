"""
Get cluster detail as JSON for API integration
"""

import json
import sys
import argparse
import db_cluster as db

# Fix encoding for Windows console
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def get_cluster_detail(cluster_id):
    """Get detailed information about a cluster"""
    cluster = db.get_cluster_details(cluster_id)
    
    if not cluster:
        return {'error': 'Cluster not found'}
    
    # Convert dates to strings
    if cluster.get('event_date'):
        cluster['event_date'] = str(cluster['event_date'])
    if cluster.get('created_at'):
        cluster['created_at'] = str(cluster['created_at'])
    if cluster.get('updated_at'):
        cluster['updated_at'] = str(cluster['updated_at'])
    
    # Process members
    if cluster.get('members'):
        for member in cluster['members']:
            if member.get('published_at'):
                member['published_at'] = str(member['published_at'])
            if member.get('added_at'):
                member['added_at'] = str(member['added_at'])
            
            # Truncate content for API response
            if member.get('content') and len(member['content']) > 500:
                member['content_preview'] = member['content'][:500] + '...'
                del member['content']  # Remove full content
    
    return cluster


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', type=int, required=True, help='Cluster ID')
    args = parser.parse_args()
    
    try:
        cluster = get_cluster_detail(args.id)
        print(json.dumps(cluster, indent=2, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
