"""
Event Clustering Service
Uses multilingual sentence transformers to identify and cluster similar news articles
"""

import numpy as np
import hashlib
import pickle
import json
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Optional
from collections import defaultdict
import time

try:
    from sentence_transformers import SentenceTransformer
    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import DBSCAN
except ImportError:
    print("ERROR: Required packages not installed.")
    print("Please run: pip install sentence-transformers scikit-learn")
    exit(1)

import db_cluster as db
import config as cfg


class EventClusteringService:
    """
    Main service for clustering news articles by event similarity
    """
    
    def __init__(self, 
                 model_name: str = None,
                 similarity_threshold: float = None,
                 time_window_hours: int = None):
        """
        Initialize the clustering service
        
        Args:
            model_name: HuggingFace model name (supports Bengali), defaults to config
            similarity_threshold: Minimum cosine similarity to consider same event (0-1), defaults to config
            time_window_hours: Only compare articles within this time window, defaults to config
        """
        # Use config defaults if not specified
        model_name = model_name or cfg.CLUSTERING_CONFIG['model_name']
        similarity_threshold = similarity_threshold if similarity_threshold is not None else cfg.CLUSTERING_CONFIG['similarity_threshold']
        time_window_hours = time_window_hours if time_window_hours is not None else cfg.CLUSTERING_CONFIG['time_window_hours']
        
        print(f"Loading model: {model_name}...")
        self.model = SentenceTransformer(model_name)
        self.model_name = model_name
        self.similarity_threshold = similarity_threshold
        self.time_window_hours = time_window_hours
        print(f"✓ Model loaded successfully!")
    
    def generate_text_hash(self, text: str) -> str:
        """Generate SHA256 hash of text for change detection"""
        return hashlib.sha256(text.encode('utf-8')).hexdigest()
    
    def prepare_article_text(self, article: Dict) -> str:
        """
        Prepare article text for embedding generation
        Combines headline and first ~500 chars of content
        """
        headline = article.get('headline') or article.get('actual_headline', '')
        content = article.get('content', '')
        
        # Take first 500 characters of content
        content_preview = content[:500] if content else ''
        
        # Combine
        combined = f"{headline}\n\n{content_preview}"
        return combined.strip()
    
    def generate_embedding(self, text: str) -> np.ndarray:
        """Generate embedding vector for text"""
        embedding = self.model.encode(text, convert_to_tensor=False)
        return embedding
    
    def store_article_embedding(self, article: Dict) -> bool:
        """Generate and store embedding for an article"""
        try:
            text = self.prepare_article_text(article)
            text_hash = self.generate_text_hash(text)
            
            # Generate embedding
            embedding = self.generate_embedding(text)
            
            # Serialize embedding as bytes
            embedding_bytes = pickle.dumps(embedding)
            
            # Store in database
            success = db.store_embedding(
                article_id=article['id'],
                embedding=embedding_bytes,
                model=self.model_name,
                text_hash=text_hash
            )
            
            return success
            
        except Exception as e:
            print(f"Error generating embedding for article {article.get('id')}: {e}")
            return False
    
    def generate_embeddings_batch(self, articles: List[Dict], batch_size: int = 32) -> Dict[int, np.ndarray]:
        """
        Generate embeddings for multiple articles in batches (faster)
        Returns: Dict mapping article_id -> embedding
        """
        embeddings_map = {}
        
        # Prepare texts
        article_ids = [a['id'] for a in articles]
        texts = [self.prepare_article_text(a) for a in articles]
        
        print(f"Generating embeddings for {len(articles)} articles...")
        
        # Generate in batches
        for i in range(0, len(texts), batch_size):
            batch_texts = texts[i:i+batch_size]
            batch_ids = article_ids[i:i+batch_size]
            
            try:
                batch_embeddings = self.model.encode(batch_texts, 
                                                    convert_to_tensor=False,
                                                    show_progress_bar=True)
                
                # Store each embedding
                for article_id, embedding, text in zip(batch_ids, batch_embeddings, batch_texts):
                    embeddings_map[article_id] = embedding
                    
                    # Also save to database
                    text_hash = self.generate_text_hash(text)
                    embedding_bytes = pickle.dumps(embedding)
                    db.store_embedding(article_id, embedding_bytes, self.model_name, text_hash)
                    
            except Exception as e:
                print(f"Error in batch {i}-{i+batch_size}: {e}")
                continue
        
        print(f"✓ Generated {len(embeddings_map)} embeddings")
        return embeddings_map
    
    def calculate_similarity_matrix(self, embeddings: np.ndarray) -> np.ndarray:
        """Calculate pairwise cosine similarity matrix"""
        return cosine_similarity(embeddings)
    
    def find_similar_articles(self, 
                            articles: List[Dict], 
                            embeddings_map: Dict[int, np.ndarray]) -> List[Tuple[int, int, float]]:
        """
        Find pairs of similar articles above threshold
        Returns: List of (article_id_1, article_id_2, similarity_score)
        """
        similar_pairs = []
        article_ids = list(embeddings_map.keys())
        embeddings = np.array([embeddings_map[aid] for aid in article_ids])
        
        # Calculate similarity matrix
        sim_matrix = self.calculate_similarity_matrix(embeddings)
        
        # Find pairs above threshold
        n = len(article_ids)
        for i in range(n):
            for j in range(i+1, n):
                similarity = sim_matrix[i, j]
                if similarity >= self.similarity_threshold:
                    similar_pairs.append((article_ids[i], article_ids[j], float(similarity)))
        
        return similar_pairs
    
    def cluster_articles_dbscan(self, 
                                articles: List[Dict], 
                                embeddings_map: Dict[int, np.ndarray]) -> Dict[int, List[int]]:
        """
        Cluster articles using DBSCAN algorithm
        Returns: Dict mapping cluster_id -> list of article_ids
        """
        article_ids = list(embeddings_map.keys())
        embeddings = np.array([embeddings_map[aid] for aid in article_ids])
        
        # DBSCAN clustering with moderate threshold for initial grouping
        # We'll filter more strictly later based on headline + content
        # Use 0.80 for DBSCAN to get focused candidate groups (works well with LaBSE)
        eps = 1.0 - 0.80  # eps = 0.20
        clustering = DBSCAN(eps=eps, min_samples=2, metric='cosine')
        labels = clustering.fit_predict(embeddings)
        
        # Group by cluster
        clusters = defaultdict(list)
        for article_id, label in zip(article_ids, labels):
            if label != -1:  # -1 means noise (no cluster)
                clusters[label].append(article_id)
        
        return dict(clusters)
    
    def select_primary_article(self, article_ids: List[int], 
                              articles_dict: Dict[int, Dict]) -> int:
        """
        Select the most comprehensive article as primary
        Criteria: longest content length
        """
        best_article_id = article_ids[0]
        max_length = 0
        
        for aid in article_ids:
            article = articles_dict.get(aid)
            if article:
                content_len = article.get('content_length', 0) or len(article.get('content', ''))
                if content_len > max_length:
                    max_length = content_len
                    best_article_id = aid
        
        return best_article_id
    
    def generate_cluster_name(self, articles: List[Dict]) -> str:
        """
        Generate a descriptive name for the cluster
        Uses the most common words from headlines
        """
        # For now, just use the primary article's headline
        # Could be improved with keyword extraction
        if articles:
            primary = articles[0]
            headline = primary.get('headline') or primary.get('actual_headline', '')
            # Truncate to reasonable length
            return headline[:100] + "..." if len(headline) > 100 else headline
        return "Unnamed Event"
    
    def create_event_cluster_from_articles(self, article_ids: List[int], 
                                          articles_dict: Dict[int, Dict],
                                          embeddings_map: Dict[int, np.ndarray]) -> Optional[int]:
        """
        Create a new event cluster from a list of articles
        Returns: cluster_id or None
        """
        if not article_ids:
            return None
        
        # Select primary article (most detailed)
        primary_id = self.select_primary_article(article_ids, articles_dict)
        primary_article = articles_dict[primary_id]
        primary_embedding = embeddings_map.get(primary_id)
        primary_headline = primary_article.get('headline', '')
        
        # Filter articles: compare each article to ALL cluster members (not just primary)
        # This allows articles to join if similar to ANY member, like DBSCAN
        filtered_article_ids = [primary_id]  # Always include primary
        filtered_count = 0
        rejected_count = 0
        
        for aid in article_ids:
            if aid == primary_id:
                continue
            article_embedding = embeddings_map.get(aid)
            article = articles_dict[aid]
            article_headline = article.get('headline', '')
            
            if article_embedding is None:
                continue
            
            # Compare against ALL current cluster members, not just primary
            best_similarity = 0.0
            best_headline_overlap = 0.0
            best_match_id = None
            
            for cluster_member_id in filtered_article_ids:
                member_embedding = embeddings_map.get(cluster_member_id)
                member_article = articles_dict[cluster_member_id]
                member_headline = member_article.get('headline', '')
                
                if member_embedding is None:
                    continue
                
                # Calculate content similarity
                content_similarity = float(cosine_similarity(
                    member_embedding.reshape(1, -1),
                    article_embedding.reshape(1, -1)
                )[0, 0])
                
                # Calculate headline similarity using simple word overlap
                member_words = set(member_headline.split())
                article_words = set(article_headline.split())
                if member_words and article_words:
                    headline_overlap = len(member_words & article_words) / len(member_words | article_words)
                else:
                    headline_overlap = 0.0
                
                # Track best match across all members
                if content_similarity > best_similarity:
                    best_similarity = content_similarity
                    best_headline_overlap = headline_overlap
                    best_match_id = cluster_member_id
            
            # Three-way filtering optimized for LaBSE (better Bengali understanding):
            # 1. Very high content similarity (paraphrased/rewritten versions)
            # 2. Good content + headline overlap (same event, different reporting style)
            # 3. HIGH headline overlap + decent content (same event, different angles/focus)
            passes = False
            reason = ""
            if best_similarity >= 0.93:
                passes = True
                reason = "very high content"
            elif best_similarity >= self.similarity_threshold and best_headline_overlap >= 0.10:
                passes = True
                reason = "content + headline"
            elif best_headline_overlap >= 0.60 and best_similarity >= 0.75:
                # Very similar headlines = definitely same event, even if content differs
                passes = True
                reason = "very high headline match"
            elif best_headline_overlap >= 0.35 and best_similarity >= 0.80:
                passes = True
                reason = "high headline overlap"
            else:
                rejected_count += 1
                reason = f"rejected (best content:{best_similarity:.3f}, headline:{best_headline_overlap:.3f})"
                
            if passes:
                filtered_article_ids.append(aid)
                filtered_count += 1
                match_info = f"vs {best_match_id}" if best_match_id != primary_id else "vs primary"
                print(f"    ✓ Added article {aid} ({reason}, {match_info}): content={best_similarity:.3f}, headline={best_headline_overlap:.3f}")
            else:
                rejected_count += 1
                # Show first few rejections to debug
                if rejected_count <=  5:
                    print(f"    ✗ Rejected article {aid} ({reason})")
        
        # Need at least 2 articles after filtering
        if len(filtered_article_ids) < 2:
            print(f"  ✗ Cluster rejected: only {len(filtered_article_ids)} article(s) after filtering ({filtered_count} added, {rejected_count} rejected)")
            return None
        
        print(f"  ✓ Cluster accepted: {len(filtered_article_ids)} articles ({filtered_count} added, {rejected_count} rejected)")
        
        article_ids = filtered_article_ids
        
        # Get other articles
        articles = [articles_dict[aid] for aid in article_ids if aid in articles_dict]
        
        # Generate cluster name
        cluster_name = self.generate_cluster_name(articles)
        
        # Get event date (use earliest publication date)
        dates = [a.get('published_at') for a in articles if a.get('published_at')]
        event_date = min(dates) if dates else datetime.now()
        if isinstance(event_date, str):
            event_date = datetime.fromisoformat(event_date.replace('Z', '+00:00'))
        
        # Get category (use primary article's category)
        category = primary_article.get('category', 'Unknown')
        
        # Combine tags
        all_tags = set()
        for article in articles:
            tags = article.get('tags', '')
            if tags:
                all_tags.update([t.strip() for t in tags.split(',')])
        combined_tags = ', '.join(all_tags)
        
        # Create cluster in database
        cluster_id = db.create_cluster(
            primary_article_id=primary_id,
            cluster_name=cluster_name,
            event_date=event_date.date(),
            category=category,
            tags=combined_tags
        )
        
        if not cluster_id:
            return None
        
        # Add all articles to cluster
        primary_embedding = embeddings_map.get(primary_id)
        
        for aid in article_ids:
            article = articles_dict.get(aid)
            if not article:
                continue
            
            is_primary = (aid == primary_id)
            
            # Calculate similarity to primary
            if is_primary:
                similarity = 1.0
            else:
                article_embedding = embeddings_map.get(aid)
                if article_embedding is not None and primary_embedding is not None:
                    similarity = float(cosine_similarity(
                        primary_embedding.reshape(1, -1),
                        article_embedding.reshape(1, -1)
                    )[0, 0])
                else:
                    similarity = 0.0
            
            content_length = article.get('content_length', 0) or len(article.get('content', ''))
            
            db.add_article_to_cluster(
                cluster_id=cluster_id,
                article_id=aid,
                similarity=similarity,
                content_length=content_length,
                source_site=article.get('source_site', ''),
                is_primary=is_primary
            )
        
        return cluster_id
    
    def run_clustering(self, hours: int = None, max_articles: Optional[int] = None) -> Dict:
        """
        Main method to run clustering on recent articles
        
        Args:
            hours: Time window in hours (default: use instance setting)
            max_articles: Maximum articles to process (for testing)
        
        Returns: Statistics about the clustering run
        """
        start_time = time.time()
        hours = hours or self.time_window_hours
        
        print(f"\n{'='*60}")
        print(f"Event Clustering Service")
        print(f"{'='*60}")
        print(f"Model: {self.model_name}")
        print(f"Time window: {hours} hours")
        print(f"Similarity threshold: {self.similarity_threshold}")
        print(f"{'='*60}\n")
        
        # Step 1: Clear old clusters to avoid duplicates
        print("Step 1: Clearing old clusters...")
        db.clear_all_clusters()
        print("✓ Database cleared\n")
        
        # Step 2: Get recent articles
        print(f"Step 2: Fetching articles from last {hours} hours...")
        articles = db.get_articles_in_timewindow(hours, limit=max_articles)
        print(f"✓ Found {len(articles)} articles\n")
        
        if not articles:
            print("No articles to process.")
            return {"articles_processed": 0, "clusters_created": 0}
        
        # Step 3: Generate embeddings
        print("Step 3: Generating embeddings...")
        embeddings_map = self.generate_embeddings_batch(articles)
        print(f"✓ Generated {len(embeddings_map)} embeddings\n")
        
        # Step 4: Cluster articles
        print("Step 4: Clustering articles...")
        clusters = self.cluster_articles_dbscan(articles, embeddings_map)
        print(f"✓ Found {len(clusters)} potential event clusters\n")
        
        # Step 5: Create clusters in database
        print("Step 5: Creating event clusters in database...")
        articles_dict = {a['id']: a for a in articles}
        clusters_created = 0
        
        for cluster_label, article_ids in clusters.items():
            if len(article_ids) >= 2:  # Only create clusters with 2+ articles
                cluster_id = self.create_event_cluster_from_articles(
                    article_ids, articles_dict, embeddings_map
                )
                if cluster_id:
                    clusters_created += 1
                    print(f"  ✓ Created cluster #{cluster_id} with {len(article_ids)} articles")
        
        print(f"\n✓ Created {clusters_created} event clusters\n")
        
        # Step 6: Log run
        execution_time = time.time() - start_time
        db.log_clustering_run(
            articles_processed=len(articles),
            clusters_created=clusters_created,
            clusters_updated=0,
            time_window_hours=hours,
            similarity_threshold=self.similarity_threshold,
            model_used=self.model_name,
            execution_time=execution_time,
            status="completed",
            notes=f"Processed {len(articles)} articles, created {clusters_created} clusters"
        )
        
        print(f"{'='*60}")
        print(f"Clustering completed in {execution_time:.2f} seconds")
        print(f"{'='*60}\n")
        
        return {
            "articles_processed": len(articles),
            "clusters_created": clusters_created,
            "execution_time": execution_time
        }


def main():
    """Run clustering on recent articles"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Event Clustering Service for News Articles')
    parser.add_argument('--hours', type=int, default=cfg.CLUSTERING_CONFIG['time_window_hours'],
                       help='Time window in hours (default: from config)')
    parser.add_argument('--threshold', type=float, default=cfg.CLUSTERING_CONFIG['similarity_threshold'],
                       help='Similarity threshold 0-1 (default: from config)')
    parser.add_argument('--max-articles', type=int, default=None,
                       help='Maximum articles to process (for testing)')
    parser.add_argument('--model', type=str, 
                       default=cfg.CLUSTERING_CONFIG['model_name'],
                       help='Sentence transformer model name (default: from config)')
    
    args = parser.parse_args()
    
    # Initialize service
    service = EventClusteringService(
        model_name=args.model,
        similarity_threshold=args.threshold,
        time_window_hours=args.hours
    )
    
    # Run clustering
    stats = service.run_clustering(
        hours=args.hours,
        max_articles=args.max_articles
    )
    
    print("\nClustering Summary:")
    print(f"  Articles processed: {stats['articles_processed']}")
    print(f"  Clusters created: {stats['clusters_created']}")
    print(f"  Execution time: {stats['execution_time']:.2f}s")


if __name__ == "__main__":
    main()
