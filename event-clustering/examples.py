"""
Example script demonstrating event clustering usage
Run this to test the clustering system with sample data
"""

import sys
from datetime import datetime, timedelta
import time

# Example 1: Basic clustering
def example_basic_clustering():
    """Run basic clustering on recent articles"""
    print("="*60)
    print("Example 1: Basic Clustering")
    print("="*60)
    print()
    
    from cluster_service import EventClusteringService
    
    # Initialize service with default settings
    service = EventClusteringService(
        similarity_threshold=0.75,
        time_window_hours=24
    )
    
    # Run clustering (limit to 50 articles for demo)
    stats = service.run_clustering(max_articles=50)
    
    print(f"\nResults:")
    print(f"  - Processed: {stats['articles_processed']} articles")
    print(f"  - Created: {stats['clusters_created']} clusters")
    print(f"  - Time: {stats['execution_time']:.2f} seconds")
    

# Example 2: View clusters
def example_view_clusters():
    """View created clusters"""
    print("\n" + "="*60)
    print("Example 2: View Clusters")
    print("="*60)
    print()
    
    import db_cluster as db
    
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT id, cluster_name, article_count, event_date, category
            FROM event_clusters
            WHERE status='active'
            ORDER BY created_at DESC
            LIMIT 5
        """)
        
        clusters = cur.fetchall()
        
        if not clusters:
            print("No clusters found. Run clustering first!")
            return
        
        print("Recent clusters:")
        print()
        
        for cluster in clusters:
            print(f"Cluster #{cluster['id']}")
            print(f"  Name: {cluster['cluster_name'][:80]}")
            print(f"  Articles: {cluster['article_count']}")
            print(f"  Category: {cluster['category']}")
            print(f"  Date: {cluster['event_date']}")
            print()
            
    finally:
        cur.close()
        conn.close()


# Example 3: Analyze a specific cluster
def example_analyze_cluster(cluster_id=None):
    """Analyze a specific cluster in detail"""
    print("\n" + "="*60)
    print("Example 3: Analyze Specific Cluster")
    print("="*60)
    print()
    
    import db_cluster as db
    
    # Get first active cluster if none specified
    if cluster_id is None:
        conn = db.get_connection()
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id FROM event_clusters WHERE status='active' LIMIT 1")
        result = cur.fetchone()
        cur.close()
        conn.close()
        
        if not result:
            print("No clusters found!")
            return
        
        cluster_id = result['id']
    
    print(f"Analyzing cluster #{cluster_id}...")
    print()
    
    cluster = db.get_cluster_details(cluster_id)
    
    if not cluster:
        print(f"Cluster {cluster_id} not found!")
        return
    
    print(f"Cluster: {cluster['cluster_name']}")
    print(f"Category: {cluster['category']}")
    print(f"Event Date: {cluster['event_date']}")
    print(f"Total Articles: {cluster['article_count']}")
    print()
    
    # Show member articles
    print("Member Articles:")
    print("-" * 60)
    
    members = cluster.get('members', [])
    for i, member in enumerate(members, 1):
        marker = "⭐ PRIMARY" if member['is_primary'] else ""
        print(f"\n{i}. {member['source_site']} {marker}")
        print(f"   Headline: {member['headline'][:70]}")
        print(f"   Length: {member['content_length']} chars")
        print(f"   Similarity: {member['similarity_to_primary']:.3f}")


# Example 4: Compare articles in a cluster
def example_compare_articles():
    """Compare how different sources report the same event"""
    print("\n" + "="*60)
    print("Example 4: Compare Coverage Across Sources")
    print("="*60)
    print()
    
    import db_cluster as db
    
    # Find a cluster with multiple sources
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT c.id, c.cluster_name, c.article_count
            FROM event_clusters c
            WHERE c.status='active' AND c.article_count >= 3
            ORDER BY c.created_at DESC
            LIMIT 1
        """)
        
        cluster_info = cur.fetchone()
        
        if not cluster_info:
            print("No multi-source clusters found!")
            return
        
        cluster_id = cluster_info['id']
        cluster = db.get_cluster_details(cluster_id)
        
        print(f"Event: {cluster['cluster_name'][:80]}")
        print(f"Sources: {cluster['article_count']}")
        print()
        print("Coverage comparison:")
        print("-" * 80)
        
        members = sorted(
            cluster.get('members', []),
            key=lambda x: x['content_length'],
            reverse=True
        )
        
        for member in members:
            is_primary = "⭐" if member['is_primary'] else "  "
            source = member['source_site'].ljust(15)
            length = str(member['content_length']).rjust(6)
            similarity = f"{member['similarity_to_primary']:.3f}"
            
            print(f"{is_primary} {source} | {length} chars | similarity: {similarity}")
        
        print()
        print("Legend: ⭐ = Most comprehensive article")
        
    finally:
        cur.close()
        conn.close()


# Example 5: Generate embedding for custom text
def example_custom_embedding():
    """Generate embedding for custom text"""
    print("\n" + "="*60)
    print("Example 5: Generate Embedding for Custom Text")
    print("="*60)
    print()
    
    from cluster_service import EventClusteringService
    import numpy as np
    
    service = EventClusteringService()
    
    # Sample Bengali text
    text1 = "ঢাকায় আজ ভারী বর্ষণ হয়েছে। রাস্তায় জলাবদ্ধতা সৃষ্টি হয়েছে।"
    text2 = "রাজধানীতে প্রবল বৃষ্টিপাত। অনেক এলাকায় পানি জমে গেছে।"
    text3 = "আজ আবহাওয়া খুব ভালো ছিল। রোদ ছিল সারাদিন।"
    
    print("Generating embeddings for 3 texts...")
    
    emb1 = service.generate_embedding(text1)
    emb2 = service.generate_embedding(text2)
    emb3 = service.generate_embedding(text3)
    
    print(f"Embedding dimension: {len(emb1)}")
    print()
    
    # Calculate similarities
    from sklearn.metrics.pairwise import cosine_similarity
    
    sim_1_2 = cosine_similarity(emb1.reshape(1, -1), emb2.reshape(1, -1))[0, 0]
    sim_1_3 = cosine_similarity(emb1.reshape(1, -1), emb3.reshape(1, -1))[0, 0]
    sim_2_3 = cosine_similarity(emb2.reshape(1, -1), emb3.reshape(1, -1))[0, 0]
    
    print("Text 1: ঢাকায় আজ ভারী বর্ষণ...")
    print("Text 2: রাজধানীতে প্রবল বৃষ্টিপাত...")
    print("Text 3: আজ আবহাওয়া খুব ভালো ছিল...")
    print()
    print("Similarity scores:")
    print(f"  Text 1 ↔ Text 2: {sim_1_2:.3f} (same topic - rain)")
    print(f"  Text 1 ↔ Text 3: {sim_1_3:.3f} (different topic)")
    print(f"  Text 2 ↔ Text 3: {sim_2_3:.3f} (different topic)")
    print()
    print("Notice: Similar articles have high similarity (>0.7)")


# Example 6: Clustering statistics
def example_statistics():
    """Show clustering statistics"""
    print("\n" + "="*60)
    print("Example 6: Clustering Statistics")
    print("="*60)
    print()
    
    import db_cluster as db
    
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        # Total clusters
        cur.execute("SELECT COUNT(*) as total FROM event_clusters WHERE status='active'")
        total = cur.fetchone()['total']
        
        # Average articles per cluster
        cur.execute("""
            SELECT AVG(article_count) as avg_count,
                   MIN(article_count) as min_count,
                   MAX(article_count) as max_count
            FROM event_clusters WHERE status='active'
        """)
        counts = cur.fetchone()
        
        # Clusters by category
        cur.execute("""
            SELECT category, COUNT(*) as count
            FROM event_clusters
            WHERE status='active'
            GROUP BY category
            ORDER BY count DESC
            LIMIT 5
        """)
        by_category = cur.fetchall()
        
        # Recent activity
        cur.execute("""
            SELECT 
                COUNT(*) as count,
                DATE(created_at) as date
            FROM event_clusters
            WHERE status='active' 
            AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        """)
        recent = cur.fetchall()
        
        print(f"Total active clusters: {total}")
        print(f"Articles per cluster: {counts['avg_count']:.1f} avg, {counts['min_count']} min, {counts['max_count']} max")
        print()
        
        print("Top categories:")
        for cat in by_category:
            print(f"  {cat['category']}: {cat['count']} clusters")
        print()
        
        print("Recent activity (last 7 days):")
        for day in recent:
            print(f"  {day['date']}: {day['count']} clusters created")
        
    finally:
        cur.close()
        conn.close()


def main():
    """Run all examples"""
    print("\n" + "="*80)
    print(" "*20 + "EVENT CLUSTERING EXAMPLES")
    print("="*80)
    
    examples = [
        ("Run basic clustering", example_basic_clustering),
        ("View recent clusters", example_view_clusters),
        ("Analyze specific cluster", lambda: example_analyze_cluster()),
        ("Compare article coverage", example_compare_articles),
        ("Generate custom embeddings", example_custom_embedding),
        ("Show statistics", example_statistics),
    ]
    
    print("\nAvailable examples:")
    for i, (name, _) in enumerate(examples, 1):
        print(f"  {i}. {name}")
    print(f"  {len(examples)+1}. Run all examples")
    print(f"  0. Exit")
    
    while True:
        try:
            choice = input("\nSelect example (0-7): ").strip()
            
            if not choice:
                continue
            
            choice = int(choice)
            
            if choice == 0:
                print("\nExiting...")
                break
            elif choice == len(examples) + 1:
                # Run all
                for name, func in examples:
                    try:
                        func()
                        time.sleep(1)
                    except Exception as e:
                        print(f"\nError in '{name}': {e}")
                        import traceback
                        traceback.print_exc()
                break
            elif 1 <= choice <= len(examples):
                name, func = examples[choice - 1]
                try:
                    func()
                except Exception as e:
                    print(f"\nError in '{name}': {e}")
                    import traceback
                    traceback.print_exc()
            else:
                print("Invalid choice!")
                
        except ValueError:
            print("Please enter a number!")
        except KeyboardInterrupt:
            print("\n\nInterrupted by user.")
            break
        except Exception as e:
            print(f"\nError: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "="*80)
    print("For more details, see README.md")
    print("="*80)


if __name__ == "__main__":
    main()
