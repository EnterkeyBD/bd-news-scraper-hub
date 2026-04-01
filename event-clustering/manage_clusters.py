"""
Cluster Management Utilities
Merge, split, archive, and manage event clusters
"""

import db_cluster as db
from rich.console import Console
from rich.prompt import Prompt, Confirm
from rich.table import Table
import sys

console = Console()


def merge_clusters(cluster_id_1: int, cluster_id_2: int):
    """
    Merge two clusters into one
    Keeps the cluster with more articles as primary
    """
    console.print(f"\n[yellow]Merging clusters {cluster_id_1} and {cluster_id_2}...[/yellow]\n")
    
    # Get both clusters
    cluster1 = db.get_cluster_details(cluster_id_1)
    cluster2 = db.get_cluster_details(cluster_id_2)
    
    if not cluster1 or not cluster2:
        console.print("[red]One or both clusters not found.[/red]")
        return False
    
    # Show cluster info
    console.print(f"[cyan]Cluster {cluster_id_1}:[/cyan] {cluster1['cluster_name']} ({cluster1['article_count']} articles)")
    console.print(f"[cyan]Cluster {cluster_id_2}:[/cyan] {cluster2['cluster_name']} ({cluster2['article_count']} articles)")
    
    # Determine which should be primary (more articles)
    if cluster1['article_count'] >= cluster2['article_count']:
        target_cluster = cluster_id_1
        source_cluster = cluster_id_2
    else:
        target_cluster = cluster_id_2
        source_cluster = cluster_id_1
    
    console.print(f"\n[green]Will merge into cluster {target_cluster}[/green]")
    
    if not Confirm.ask("Proceed with merge?"):
        console.print("[yellow]Merge cancelled.[/yellow]")
        return False
    
    # Move all articles from source to target
    conn = db.get_connection()
    cur = conn.cursor()
    
    try:
        # Update cluster_members
        cur.execute("""
            UPDATE cluster_members
            SET cluster_id = %s
            WHERE cluster_id = %s
            ON DUPLICATE KEY UPDATE
                cluster_id = cluster_id  -- Keep existing if duplicate
        """, (target_cluster, source_cluster))
        
        # Archive source cluster
        cur.execute("""
            UPDATE event_clusters
            SET status = 'merged', 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (source_cluster,))
        
        # Update target cluster counts
        cur.execute("""
            UPDATE event_clusters
            SET article_count = (
                SELECT COUNT(DISTINCT article_id) 
                FROM cluster_members 
                WHERE cluster_id = %s
            ),
            updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (target_cluster, target_cluster))
        
        conn.commit()
        console.print(f"[green]✓ Clusters merged successfully![/green]")
        return True
        
    except Exception as e:
        console.print(f"[red]Error merging clusters: {e}[/red]")
        conn.rollback()
        return False
    finally:
        cur.close()
        conn.close()


def archive_cluster(cluster_id: int):
    """Archive a cluster (mark as inactive)"""
    cluster = db.get_cluster_details(cluster_id)
    
    if not cluster:
        console.print(f"[red]Cluster {cluster_id} not found.[/red]")
        return False
    
    console.print(f"\n[yellow]Archiving cluster {cluster_id}:[/yellow]")
    console.print(f"{cluster['cluster_name']} ({cluster['article_count']} articles)\n")
    
    if not Confirm.ask("Archive this cluster?"):
        console.print("[yellow]Archive cancelled.[/yellow]")
        return False
    
    conn = db.get_connection()
    cur = conn.cursor()
    
    try:
        cur.execute("""
            UPDATE event_clusters
            SET status = 'archived',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (cluster_id,))
        
        conn.commit()
        console.print(f"[green]✓ Cluster archived successfully![/green]")
        return True
        
    except Exception as e:
        console.print(f"[red]Error archiving cluster: {e}[/red]")
        conn.rollback()
        return False
    finally:
        cur.close()
        conn.close()


def remove_article_from_cluster(cluster_id: int, article_id: int):
    """Remove a specific article from a cluster"""
    console.print(f"\n[yellow]Removing article {article_id} from cluster {cluster_id}...[/yellow]\n")
    
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        # Check if article is primary
        cur.execute("""
            SELECT is_primary FROM cluster_members
            WHERE cluster_id = %s AND article_id = %s
        """, (cluster_id, article_id))
        
        member = cur.fetchone()
        
        if not member:
            console.print("[red]Article not found in this cluster.[/red]")
            return False
        
        if member['is_primary']:
            console.print("[red]Cannot remove primary article. Set a new primary first.[/red]")
            return False
        
        # Remove article
        cur.execute("""
            DELETE FROM cluster_members
            WHERE cluster_id = %s AND article_id = %s
        """, (cluster_id, article_id))
        
        # Update cluster count
        cur.execute("""
            UPDATE event_clusters
            SET article_count = article_count - 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (cluster_id,))
        
        conn.commit()
        console.print(f"[green]✓ Article removed successfully![/green]")
        return True
        
    except Exception as e:
        console.print(f"[red]Error removing article: {e}[/red]")
        conn.rollback()
        return False
    finally:
        cur.close()
        conn.close()


def change_cluster_primary(cluster_id: int, new_primary_id: int):
    """Change the primary article of a cluster"""
    console.print(f"\n[yellow]Changing primary article for cluster {cluster_id}...[/yellow]\n")
    
    # Verify article is in cluster
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT article_id FROM cluster_members
            WHERE cluster_id = %s AND article_id = %s
        """, (cluster_id, new_primary_id))
        
        if not cur.fetchone():
            console.print("[red]Article not found in this cluster.[/red]")
            return False
        
        # Update primary
        success = db.update_cluster_primary(cluster_id, new_primary_id)
        
        if success:
            console.print(f"[green]✓ Primary article updated successfully![/green]")
        else:
            console.print("[red]Failed to update primary article.[/red]")
        
        return success
        
    finally:
        cur.close()
        conn.close()


def delete_cluster(cluster_id: int):
    """Permanently delete a cluster (use with caution!)"""
    cluster = db.get_cluster_details(cluster_id)
    
    if not cluster:
        console.print(f"[red]Cluster {cluster_id} not found.[/red]")
        return False
    
    console.print(f"\n[red]WARNING: Permanently deleting cluster {cluster_id}:[/red]")
    console.print(f"{cluster['cluster_name']} ({cluster['article_count']} articles)\n")
    console.print("[red]This will remove all cluster associations but NOT delete the articles themselves.[/red]\n")
    
    if not Confirm.ask("Are you sure?"):
        console.print("[yellow]Deletion cancelled.[/yellow]")
        return False
    
    conn = db.get_connection()
    cur = conn.cursor()
    
    try:
        # Delete cluster (CASCADE will delete members)
        cur.execute("DELETE FROM event_clusters WHERE id = %s", (cluster_id,))
        
        conn.commit()
        console.print(f"[green]✓ Cluster deleted successfully![/green]")
        return True
        
    except Exception as e:
        console.print(f"[red]Error deleting cluster: {e}[/red]")
        conn.rollback()
        return False
    finally:
        cur.close()
        conn.close()


def recalculate_cluster_similarity(cluster_id: int):
    """Recalculate similarity scores for all articles in a cluster"""
    console.print(f"\n[yellow]Recalculating similarities for cluster {cluster_id}...[/yellow]\n")
    
    cluster = db.get_cluster_details(cluster_id)
    if not cluster:
        console.print(f"[red]Cluster {cluster_id} not found.[/red]")
        return False
    
    try:
        from cluster_service import EventClusteringService
        import pickle
        
        service = EventClusteringService()
        
        # Get embeddings for all articles in cluster
        conn = db.get_connection()
        cur = conn.cursor(dictionary=True)
        
        cur.execute("""
            SELECT cm.article_id, ae.embedding
            FROM cluster_members cm
            JOIN article_embeddings ae ON cm.article_id = ae.article_id
            WHERE cm.cluster_id = %s
        """, (cluster_id,))
        
        articles = cur.fetchall()
        
        if not articles:
            console.print("[red]No embeddings found for cluster articles.[/red]")
            return False
        
        # Get primary article
        primary_id = cluster['primary_article_id']
        primary_embedding = None
        
        for article in articles:
            if article['article_id'] == primary_id:
                primary_embedding = pickle.loads(article['embedding'])
                break
        
        if primary_embedding is None:
            console.print("[red]Primary article embedding not found.[/red]")
            return False
        
        # Recalculate similarities
        from sklearn.metrics.pairwise import cosine_similarity
        import numpy as np
        
        for article in articles:
            article_id = article['article_id']
            embedding = pickle.loads(article['embedding'])
            
            if article_id == primary_id:
                similarity = 1.0
            else:
                similarity = float(cosine_similarity(
                    primary_embedding.reshape(1, -1),
                    embedding.reshape(1, -1)
                )[0, 0])
            
            # Update in database
            cur.execute("""
                UPDATE cluster_members
                SET similarity_to_primary = %s
                WHERE cluster_id = %s AND article_id = %s
            """, (similarity, cluster_id, article_id))
        
        conn.commit()
        console.print(f"[green]✓ Similarities recalculated for {len(articles)} articles![/green]")
        return True
        
    except Exception as e:
        console.print(f"[red]Error recalculating similarities: {e}[/red]")
        if 'conn' in locals():
            conn.rollback()
        return False
    finally:
        if 'cur' in locals():
            cur.close()
        if 'conn' in locals():
            conn.close()


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Manage Event Clusters')
    
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # Merge command
    merge_parser = subparsers.add_parser('merge', help='Merge two clusters')
    merge_parser.add_argument('cluster1', type=int, help='First cluster ID')
    merge_parser.add_argument('cluster2', type=int, help='Second cluster ID')
    
    # Archive command
    archive_parser = subparsers.add_parser('archive', help='Archive a cluster')
    archive_parser.add_argument('cluster_id', type=int, help='Cluster ID to archive')
    
    # Delete command
    delete_parser = subparsers.add_parser('delete', help='Delete a cluster')
    delete_parser.add_argument('cluster_id', type=int, help='Cluster ID to delete')
    
    # Remove article command
    remove_parser = subparsers.add_parser('remove-article', help='Remove article from cluster')
    remove_parser.add_argument('cluster_id', type=int, help='Cluster ID')
    remove_parser.add_argument('article_id', type=int, help='Article ID to remove')
    
    # Change primary command
    primary_parser = subparsers.add_parser('set-primary', help='Set new primary article')
    primary_parser.add_argument('cluster_id', type=int, help='Cluster ID')
    primary_parser.add_argument('article_id', type=int, help='New primary article ID')
    
    # Recalculate command
    recalc_parser = subparsers.add_parser('recalculate', help='Recalculate cluster similarities')
    recalc_parser.add_argument('cluster_id', type=int, help='Cluster ID')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    if args.command == 'merge':
        merge_clusters(args.cluster1, args.cluster2)
    elif args.command == 'archive':
        archive_cluster(args.cluster_id)
    elif args.command == 'delete':
        delete_cluster(args.cluster_id)
    elif args.command == 'remove-article':
        remove_article_from_cluster(args.cluster_id, args.article_id)
    elif args.command == 'set-primary':
        change_cluster_primary(args.cluster_id, args.article_id)
    elif args.command == 'recalculate':
        recalculate_cluster_similarity(args.cluster_id)


if __name__ == "__main__":
    main()
