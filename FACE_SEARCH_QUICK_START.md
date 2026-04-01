# Quick Start Guide - Enhanced Face Search Features

## 🚀 Quick Access

Visit: **http://localhost:3000/find-people.html**

## 🎯 Three Search Modes

### 1️⃣ Find Person (Default Mode)
**What it does**: Find all images containing a specific person

**Steps**:
1. Click or drag & drop 1-10 photos of the person
2. Adjust similarity threshold (default: 0.40)
3. Click "Search"
4. View results with matching images and article details

**Tip**: Upload multiple photos (different angles) for 15-25% better accuracy

---

### 2️⃣ Find Relations (NEW!)
**What it does**: Discover who frequently appears with the target person

**Steps**:
1. Click "Find Relations" button at the top
2. Upload 1-10 photos of the target person
3. Adjust thresholds:
   - **Similarity**: How strictly to match the target (default: 0.40)
   - **Cluster**: How strictly to group associates (default: 0.35)
4. Click "Search"
5. View associates sorted by co-appearance count

**Results show**:
- Count: How many times they appear together
- Representative face for each associate
- All co-appearance images with details
- Auto-tagged names (if saved previously)

**Use cases**:
- Find political associates
- Discover business connections
- Map social networks
- Investigative journalism

---

### 3️⃣ Find Pair (NEW!)
**What it does**: Find images where TWO specific people appear together

**Steps**:
1. Click "Find Pair" button at the top
2. Upload photos of Person A (left zone)
3. Upload photos of Person B (right zone)
4. Adjust similarity threshold (default: 0.40)
5. Click "Find Together"
6. View images where both appear together

**Use cases**:
- Find meeting photos
- Event coverage
- Relationship verification
- Timeline tracking

---

## 💾 Named Face Database (NEW!)

### Save a Name (Coming to UI soon)
Currently via API:

```bash
curl -X POST http://localhost:3000/api/face-names/save \
  -F "name=John Smith" \
  -F "images=@photo1.jpg" \
  -F "images=@photo2.jpg"
```

### List Saved Names
```bash
curl http://localhost:3000/api/face-names/list
```

### Search by Name
```bash
curl -X POST http://localhost:3000/api/face-search-by-name \
  -H "Content-Type: application/json" \
  -d '{"name": "John Smith", "threshold": 0.4}'
```

### Delete Name
```bash
curl -X DELETE http://localhost:3000/api/face-names/John%20Smith
```

---

## 🎛️ Threshold Guide

### Similarity Threshold (0.20 - 0.80)
Controls how strictly faces are matched:

- **0.30 - Loose**: More matches, more false positives
- **0.40 - Balanced** ✅ (Recommended)
- **0.50 - Strict**: Fewer matches, higher accuracy
- **0.60+ - Very Strict**: Only very clear matches

**When to adjust**:
- Too many wrong faces → Increase (0.40 → 0.50)
- Missing correct matches → Decrease (0.40 → 0.35)

### Cluster Threshold (0.20 - 0.60, Relation Search Only)
Controls how associates are grouped:

- **0.30 - Loose**: May merge different people
- **0.35 - Balanced** ✅ (Recommended)
- **0.40+ - Strict**: May split same person into multiple clusters

**When to adjust**:
- Same person appearing as multiple clusters → Decrease (0.35 → 0.30)
- Different people grouped together → Increase (0.35 → 0.40)

---

## 🔧 Index Management

### Check Index Status
The status bar shows:
- Total faces indexed
- Total images indexed
- New unindexed images
- Last update time

### Build/Update Index
1. Click "Build Index" button
2. Monitor progress in real-time
3. Index auto-updates with new images

### Auto-Build (Recommended)
1. Set threshold (e.g., 10 new images)
2. Click "Save"
3. Index automatically rebuilds when threshold reached
4. Checks every 2 minutes

**Recommended**: Set to 10-20 for daily scrapers

---

## 💡 Pro Tips

### For Best Results
1. **Multiple Photos**: Upload 3-5 photos of different angles
2. **Quality**: Use clear, well-lit, frontal face photos
3. **Strategy**: Keep "hybrid" (default) for best accuracy
4. **Thresholds**: Start with defaults, adjust if needed

### Relation Search Tips
1. **Target Photos**: Use clear, high-quality photos
2. **Lower Threshold**: Try 0.35 for more associates
3. **Review Clusters**: Check representative faces
4. **Save Names**: Tag frequent associates for future use

### Pair Search Tips
1. **Both Persons**: Upload 2-3 photos of each
2. **Different People**: Ensure photos show different individuals
3. **Combined Score**: Results sorted by sum of both scores

---

## 🎨 UI Features

### Drag & Drop
- Drag multiple files onto upload zone
- Works for all three modes
- Preview thumbnails before search

### Real-Time Progress
- Index build progress shown in real-time
- Socket.IO updates
- Cancel anytime

### Result Actions
- Click image to view full article
- Hover for quick preview
- Clear results to start fresh

---

## 🐛 Common Issues

### "No face detected"
**Solutions**:
- Ensure photos show clear frontal faces
- Check photo isn't too small (< 40px)
- Try different photos
- Avoid profile shots or back-of-head

### "No matching faces found"
**Solutions**:
- Lower similarity threshold (0.40 → 0.35)
- Upload more/better quality photos
- Check if face index is built
- Verify person actually appears in indexed images

### Relation search shows wrong people
**Solutions**:
- Increase cluster threshold (0.35 → 0.40)
- Increase similarity threshold (0.40 → 0.45)
- Upload clearer target photos

### Pair search finds nothing
**Solutions**:
- Lower similarity threshold
- Ensure both people actually appear together
- Check if images are indexed
- Upload more photos of each person

---

## 📊 Performance Notes

- **Relation Search**: Slower for very common faces (processes all appearances)
- **Pair Search**: Optimized, typically faster than relation search
- **Index Build**: ~100-200 images/second (varies by CPU)
- **Search Speed**: ~1-3 seconds for typical queries

---

## 🔮 Coming Soon

- Web UI for name management
- Bulk name tagging from relation results
- Export relation networks
- Temporal analysis (timeline view)
- Demographics estimation

---

## 📚 More Details

For technical details, API documentation, and advanced usage:
→ See `FACE_SEARCH_FEATURES.md`

For system architecture and setup:
→ See `README.md`

---

**Happy searching! 🔍**
