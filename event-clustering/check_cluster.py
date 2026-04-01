import json
import sys

cluster_id = sys.argv[1] if len(sys.argv) > 1 else "3"

import subprocess
result = subprocess.run(['python', 'get_cluster_detail.py', '--id', cluster_id], 
                       capture_output=True, text=True, encoding='utf-8')
data = json.loads(result.stdout)

print(f"Cluster: {data['cluster_name']}")
print(f"Articles: {data['article_count']}")
print(f"\nMembers (similarity scores):")
for m in data['members'][:15]:
    print(f"  {m['similarity_to_primary']:.3f} - {m['headline'][:80]}")
