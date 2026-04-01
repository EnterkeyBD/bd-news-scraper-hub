"""
View and analyze event clusters
"""

import db_cluster as db
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import box
from datetime import datetime
import sys

console = Console()


def show_all_clusters(limit: int = 50):
    """Display all event clusters"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT c.id, c.cluster_name, c.article_count, c.event_date, c.category,
                   c.created_at, a.headline as primary_headline, a.source_site as primary_source
            FROM event_clusters c
            LEFT JOIN articles a ON c.primary_article_id = a.id
            WHERE c.status = 'active'
            ORDER BY c.event_date DESC, c.created_at DESC
            LIMIT %s
        """, (limit,))
        
        clusters = cur.fetchall()
        
        if not clusters:
            console.print("[yellow]No clusters found.[/yellow]")
            return
        
        table = Table(title=f"Event Clusters (Last {limit})", box=box.ROUNDED)
        table.add_column("ID", style="cyan", width=6)
        table.add_column("Cluster Name", style="green", width=50)
        table.add_column("Articles", justify="center", width=10)
        table.add_column("Category", width=15)
        table.add_column("Event Date", width=12)
        table.add_column("Primary Source", width=15)
        
        for cluster in clusters:
            cluster_name = cluster['cluster_name'] or "Unnamed"
            if len(cluster_name) > 50:
                cluster_name = cluster_name[:47] + "..."
            
            table.add_row(
                str(cluster['id']),
                cluster_name,
                str(cluster['article_count']),
                cluster['category'] or "N/A",
                str(cluster['event_date']) if cluster['event_date'] else "N/A",
                cluster['primary_source'] or "N/A"
            )
        
        console.print(table)
        console.print(f"\n[dim]Total clusters: {len(clusters)}[/dim]")
        
    finally:
        cur.close()
        conn.close()


def show_cluster_detail(cluster_id: int):
    """Show detailed information about a specific cluster"""
    cluster = db.get_cluster_details(cluster_id)
    
    if not cluster:
        console.print(f"[red]Cluster {cluster_id} not found.[/red]")
        return
    
    # Cluster header
    console.print(Panel(
        f"[bold cyan]Cluster #{cluster['id']}[/bold cyan]\n"
        f"[green]{cluster['cluster_name']}[/green]\n\n"
        f"Category: {cluster['category']}\n"
        f"Event Date: {cluster['event_date']}\n"
        f"Articles: {cluster['article_count']}\n"
        f"Status: {cluster['status']}",
        title="Event Cluster Details",
        border_style="cyan"
    ))
    
    # Member articles table
    if cluster.get('members'):
        table = Table(title="Member Articles", box=box.SIMPLE)
        table.add_column("ID", style="cyan", width=6)
        table.add_column("Source", width=15)
        table.add_column("Headline", style="green", width=60)
        table.add_column("Length", justify="right", width=8)
        table.add_column("Similarity", justify="center", width=10)
        table.add_column("Primary", justify="center", width=8)
        
        for member in cluster['members']:
            headline = member['headline'] or member['actual_headline'] or "No headline"
            if len(headline) > 60:
                headline = headline[:57] + "..."
            
            similarity = f"{member['similarity_to_primary']:.3f}" if member['similarity_to_primary'] else "N/A"
            primary_marker = "⭐" if member['is_primary'] else ""
            content_length = member['content_length'] or 0
            
            style = "bold yellow" if member['is_primary'] else ""
            
            table.add_row(
                str(member['article_id']),
                member['source_site'],
                headline,
                str(content_length),
                similarity,
                primary_marker,
                style=style
            )
        
        console.print(table)
        
        # Show full primary article details
        primary = next((m for m in cluster['members'] if m['is_primary']), None)
        if primary:
            console.print(Panel(
                f"[bold]Headline:[/bold] {primary['headline']}\n\n"
                f"[bold]Source:[/bold] {primary['source_site']}\n"
                f"[bold]Published:[/bold] {primary['published_at']}\n"
                f"[bold]URL:[/bold] {primary['source_url']}\n\n"
                f"[bold]Content Preview:[/bold]\n{primary['content'][:500]}...",
                title="⭐ Primary Article (Most Detailed)",
                border_style="yellow"
            ))


def show_cluster_statistics():
    """Show overall clustering statistics"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        # Total clusters
        cur.execute("SELECT COUNT(*) as total FROM event_clusters WHERE status='active'")
        total_clusters = cur.fetchone()['total']
        
        # Clusters by category
        cur.execute("""
            SELECT category, COUNT(*) as count
            FROM event_clusters
            WHERE status='active'
            GROUP BY category
            ORDER BY count DESC
            LIMIT 10
        """)
        by_category = cur.fetchall()
        
        # Average articles per cluster
        cur.execute("""
            SELECT AVG(article_count) as avg_articles
            FROM event_clusters
            WHERE status='active'
        """)
        avg_articles = cur.fetchone()['avg_articles'] or 0
        
        # Recent activity
        cur.execute("""
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM event_clusters
            WHERE status='active' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        """)
        recent_activity = cur.fetchall()
        
        # Display statistics
        console.print(Panel(
            f"[bold cyan]Total Active Clusters:[/bold cyan] {total_clusters}\n"
            f"[bold cyan]Avg Articles per Cluster:[/bold cyan] {avg_articles:.1f}",
            title="Clustering Statistics",
            border_style="cyan"
        ))
        
        # Category table
        if by_category:
            table = Table(title="Clusters by Category", box=box.SIMPLE)
            table.add_column("Category", style="green")
            table.add_column("Count", justify="right")
            
            for row in by_category:
                table.add_row(row['category'], str(row['count']))
            
            console.print(table)
        
        # Recent activity
        if recent_activity:
            table = Table(title="Recent Activity (Last 7 Days)", box=box.SIMPLE)
            table.add_column("Date", style="cyan")
            table.add_column("Clusters Created", justify="right")
            
            for row in recent_activity:
                table.add_row(str(row['date']), str(row['count']))
            
            console.print(table)
        
    finally:
        cur.close()
        conn.close()


def show_clustering_history(limit: int = 10):
    """Show clustering run history"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT * FROM clustering_history
            ORDER BY run_date DESC
            LIMIT %s
        """, (limit,))
        
        runs = cur.fetchall()
        
        if not runs:
            console.print("[yellow]No clustering runs found.[/yellow]")
            return
        
        table = Table(title=f"Clustering Run History (Last {limit})", box=box.ROUNDED)
        table.add_column("ID", style="cyan", width=6)
        table.add_column("Date", width=20)
        table.add_column("Articles", justify="right", width=10)
        table.add_column("Clusters", justify="right", width=10)
        table.add_column("Time (s)", justify="right", width=10)
        table.add_column("Threshold", justify="right", width=10)
        table.add_column("Status", width=12)
        
        for run in runs:
            table.add_row(
                str(run['id']),
                str(run['run_date']),
                str(run['articles_processed']),
                str(run['clusters_created']),
                f"{run['execution_time_seconds']:.2f}",
                f"{run['similarity_threshold']:.2f}",
                run['status']
            )
        
        console.print(table)
        
    finally:
        cur.close()
        conn.close()


def search_clusters(keyword: str):
    """Search clusters by keyword in cluster name"""
    conn = db.get_connection()
    cur = conn.cursor(dictionary=True)
    
    try:
        cur.execute("""
            SELECT c.id, c.cluster_name, c.article_count, c.event_date, c.category
            FROM event_clusters c
            WHERE c.cluster_name LIKE %s AND c.status = 'active'
            ORDER BY c.event_date DESC
            LIMIT 50
        """, (f"%{keyword}%",))
        
        clusters = cur.fetchall()
        
        if not clusters:
            console.print(f"[yellow]No clusters found matching '{keyword}'.[/yellow]")
            return
        
        table = Table(title=f"Search Results: '{keyword}'", box=box.ROUNDED)
        table.add_column("ID", style="cyan", width=6)
        table.add_column("Cluster Name", style="green", width=60)
        table.add_column("Articles", justify="center", width=10)
        table.add_column("Event Date", width=12)
        
        for cluster in clusters:
            table.add_row(
                str(cluster['id']),
                cluster['cluster_name'][:60],
                str(cluster['article_count']),
                str(cluster['event_date']) if cluster['event_date'] else "N/A"
            )
        
        console.print(table)
        console.print(f"\n[dim]Found {len(clusters)} clusters[/dim]")
        
    finally:
        cur.close()
        conn.close()


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='View Event Clusters')
    parser.add_argument('--list', action='store_true', help='List all clusters')
    parser.add_argument('--detail', type=int, help='Show detail for cluster ID')
    parser.add_argument('--stats', action='store_true', help='Show statistics')
    parser.add_argument('--history', action='store_true', help='Show clustering run history')
    parser.add_argument('--search', type=str, help='Search clusters by keyword')
    parser.add_argument('--limit', type=int, default=50, help='Result limit')
    
    args = parser.parse_args()
    
    if args.detail:
        show_cluster_detail(args.detail)
    elif args.stats:
        show_cluster_statistics()
    elif args.history:
        show_clustering_history(args.limit)
    elif args.search:
        search_clusters(args.search)
    elif args.list:
        show_all_clusters(args.limit)
    else:
        # Default: show statistics
        show_cluster_statistics()
        console.print("\n[dim]Use --help to see all options[/dim]")


if __name__ == "__main__":
    main()
