#!/usr/bin/env python
# -*- coding: utf-8 -*-
import mysql.connector
import sys

# Fix encoding
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

cn = mysql.connector.connect(
    host='103.213.38.238',
    user='siamvidb_scraptestg',
    password='HuHmf!w=E]%I=3L&',
    database='siamvidb_scraptestg'
)

cr = cn.cursor(dictionary=True)

# Find Hadi murder articles
cr.execute("""
    SELECT id, headline, source_site, published_at 
    FROM articles 
    WHERE headline LIKE '%হাদি%হত্যা%' 
       OR headline LIKE '%ওসমান হাদি%'
    ORDER BY published_at DESC 
    LIMIT 10
""")

rows = cr.fetchall()

print(f"Found {len(rows)} articles about Hadi murder:\n")
for r in rows:
    print(f"ID: {r['id']}")
    print(f"Source: {r['source_site']}")
    print(f"Date: {r['published_at']}")
    print(f"Headline: {r['headline']}")
    print("-" * 80)

cn.close()
