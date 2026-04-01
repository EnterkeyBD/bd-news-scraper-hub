#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Compare different embedding models for Bengali text clustering
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import time
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
import db_cluster as db

# Test articles: Hadi murder case from different sources
article_ids = [4384, 4498, 4381]  # Should cluster together

# Get articles
conn = db.get_connection()
cur = conn.cursor(dictionary=True)
cur.execute(f"""
    SELECT id, headline, content 
    FROM articles 
    WHERE id IN ({','.join(map(str, article_ids))})
""")
articles = cur.fetchall()
conn.close()

print("Testing Bengali Embedding Models")
print("=" * 80)
print("\nTest Articles (Hadi murder case - SHOULD cluster together):")
for a in articles:
    print(f"  {a['id']}: {a['headline']}")

# Models to test
models_to_test = [
    ('paraphrase-multilingual-MiniLM-L12-v2', 'Current: Fast multilingual (384d)'),
    ('sentence-transformers/LaBSE', 'Better: Language-agnostic (768d)'),
    ('sentence-transformers/paraphrase-multilingual-mpnet-base-v2', 'Best: MPNet multilingual (768d)'),
]

print("\n" + "=" * 80)

for model_name, description in models_to_test:
    print(f"\n\n{'='*80}")
    print(f"Model: {model_name}")
    print(f"Description: {description}")
    print(f"{'='*80}")
    
    try:
        start = time.time()
        print(f"Loading model...", end='', flush=True)
        model = SentenceTransformer(model_name)
        load_time = time.time() - start
        print(f" Done ({load_time:.2f}s)")
        
        # Generate embeddings
        print(f"Generating embeddings...", end='', flush=True)
        start = time.time()
        texts = [a['headline'] + ' ' + (a['content'] or '')[:500] for a in articles]
        embeddings = model.encode(texts, show_progress_bar=False)
        embed_time = time.time() - start
        print(f" Done ({embed_time:.2f}s)")
        
        # Calculate similarities
        print(f"\nSimilarity scores:")
        print(f"{'Pair':<30} {'Content':<10} {'Headline':<12} {'Assessment'}")
        print("-" * 80)
        
        for i in range(len(articles)):
            for j in range(i+1, len(articles)):
                a1, a2 = articles[i], articles[j]
                
                # Content similarity
                content_sim = cosine_similarity(
                    embeddings[i].reshape(1, -1),
                    embeddings[j].reshape(1, -1)
                )[0, 0]
                
                # Headline overlap
                h1_words = set(a1['headline'].split())
                h2_words = set(a2['headline'].split())
                headline_overlap = len(h1_words & h2_words) / len(h1_words | h2_words) if (h1_words | h2_words) else 0
                
                # Assessment
                if content_sim >= 0.80 and headline_overlap >= 0.12:
                    assessment = "✓ PASS"
                elif headline_overlap >= 0.40 and content_sim >= 0.68:
                    assessment = "✓ PASS (headline)"
                elif content_sim >= 0.92:
                    assessment = "✓ PASS (content)"
                else:
                    assessment = "✗ FAIL"
                
                pair_name = f"{a1['id']}-{a2['id']}"
                print(f"{pair_name:<30} {content_sim:<10.3f} {headline_overlap:<12.3f} {assessment}")
        
        print(f"\nModel dimensions: {embeddings.shape[1]}d")
        print(f"Total time: {load_time + embed_time:.2f}s")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        print(f"   (Model may need to be downloaded first)")

print("\n\n" + "=" * 80)
print("RECOMMENDATION:")
print("=" * 80)
print("""
For Bengali news clustering, based on similarity scores:

1. **LaBSE** - Best balance of accuracy and speed for Bengali
   - 768-dimensional embeddings
   - Specifically designed for cross-lingual semantic similarity
   - Better Bengali understanding than MiniLM

2. **MPNet-multilingual** - Highest accuracy but slower
   - 768-dimensional embeddings  
   - Best semantic understanding
   - Use if accuracy is more important than speed

3. **Current MiniLM** - Fast but may miss some matches
   - 384-dimensional embeddings
   - Good for testing but not ideal for production

To switch models, edit config.py:
    'model_name': 'sentence-transformers/LaBSE'
""")
