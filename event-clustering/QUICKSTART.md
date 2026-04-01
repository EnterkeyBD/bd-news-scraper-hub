# 🚀 Quick Start - Event Clustering

## 3-Step Setup

### 1. Install Dependencies
```bash
cd event-clustering
pip install sentence-transformers scikit-learn rich
```

### 2. Create Database Tables
```bash
python db_cluster.py
```

### 3. Access Dashboard
```
http://localhost:3000/clusters.html
```
(Make sure scraper-manager is running)

## First Use

1. **Click** "▶ Run Clustering" button
2. **Wait** 2-3 minutes (first run downloads AI model)
3. **View** your event clusters!

## Example Output

```
Event Cluster #1: "ঢাকায় বন্যা পরিস্থিতি"
├── jugantor    - 1200 words ⭐ (most detailed)
├── prothomalo  -  950 words  (87% similar)
├── kalbela     -  800 words  (82% similar)
└── bdnews24    -  700 words  (79% similar)
```

## Settings

- **Time Window**: 24 hours (looking back)
- **Threshold**: 0.75 (75% similarity required)
- **Articles**: All sources automatically included

## That's It!

The system is now live and integrated with your scraper manager.

Happy clustering! 🎉
