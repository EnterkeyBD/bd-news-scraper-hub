# -*- coding: utf-8 -*-
"""
Face Search Engine for Multi-Scraper News Images.

Uses ONNX Runtime directly with InsightFace SCRFD + ArcFace models.
No insightface Python package required - just onnxruntime, opencv, numpy.

Usage:
    python face_search.py --build-index          Build/update face embedding index
    python face_search.py --search <image_path>  Search for matching faces
        [--threshold 0.4] [--limit 20]

Requires: onnxruntime, opencv-python-headless, numpy
Models:   ~/.insightface/models/buffalo_l/det_10g.onnx (SCRFD detection)
          ~/.insightface/models/buffalo_l/w600k_r50.onnx (ArcFace recognition)
"""

import argparse
import json
import os
import pickle
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

# Directories to scan for news images (relative to this script)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)

IMAGE_DIRS = [
    os.path.join(SCRIPT_DIR, 'news_images', 'ittefaq'),
    os.path.join(SCRIPT_DIR, 'news_images', 'jugantor'),
    os.path.join(SCRIPT_DIR, 'news_images', 'kalbela'),
    os.path.join(SCRIPT_DIR, 'news_images', 'desh'),
    os.path.join(SCRIPT_DIR, 'news_images', 'bdnews24'),
    os.path.join(SCRIPT_DIR, 'news_images', 'prothomalo'),
    os.path.join(SCRIPT_DIR, 'news_images', 'dhakapost'),
    os.path.join(SCRIPT_DIR, 'news_images', 'jagonews24'),
    os.path.join(SCRIPT_DIR, 'news_images', 'samakal'),
    os.path.join(SCRIPT_DIR, 'news_images', 'sangbad'),
    os.path.join(SCRIPT_DIR, 'news_images', 'amadershomoy'),
    os.path.join(SCRIPT_DIR, 'news_images', 'bdpratidin'),
    os.path.join(SCRIPT_DIR, 'news_images', 'mzamin'),
    os.path.join(SCRIPT_DIR, 'news_images', 'dhakatribune'),
    os.path.join(SCRIPT_DIR, 'news_images', 'janakantha'),
    os.path.join(SCRIPT_DIR, 'news_images', 'boishakhi'),
]

MODEL_DIR = os.path.join(os.path.expanduser('~'), '.insightface', 'models', 'buffalo_l')
DET_MODEL = os.path.join(MODEL_DIR, 'det_10g.onnx')
REC_MODEL = os.path.join(MODEL_DIR, 'w600k_r50.onnx')

INDEX_FILE = os.path.join(SCRIPT_DIR, 'face_index.pkl')
META_FILE = os.path.join(SCRIPT_DIR, 'face_index_meta.json')
PROCESSED_FILE = os.path.join(SCRIPT_DIR, 'face_index_processed.json')
HASH_FILE = os.path.join(SCRIPT_DIR, 'face_index_hashes.json')
NAMES_FILE = os.path.join(SCRIPT_DIR, 'face_names.pkl')

VALID_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}

# Minimum face size (pixels) to index - filters out tiny/distant faces
MIN_FACE_SIZE = 40

# Standard face alignment template for ArcFace (112x112)
ARCFACE_DST = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)


def compute_phash(img, hash_size=8):
    """Compute perceptual hash (pHash) of an image using OpenCV DCT.
    Returns a hex string. Similar images produce hashes with small hamming distance."""
    resized = cv2.resize(img, (hash_size * 4, hash_size * 4), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY) if len(resized.shape) == 3 else resized
    gray = gray.astype(np.float32)
    dct = cv2.dct(gray)
    dct_low = dct[:hash_size, :hash_size]
    median = np.median(dct_low)
    bits = (dct_low > median).flatten()
    # Pack bits into hex string
    hash_int = 0
    for bit in bits:
        hash_int = (hash_int << 1) | int(bit)
    return format(hash_int, f'0{hash_size * hash_size // 4}x')


def hamming_distance(h1, h2):
    """Compute hamming distance between two hex hash strings."""
    n1 = int(h1, 16)
    n2 = int(h2, 16)
    xor = n1 ^ n2
    return bin(xor).count('1')


def load_hash_index():
    """Load perceptual hash index: {hash_hex: filename}."""
    if os.path.exists(HASH_FILE):
        try:
            with open(HASH_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_hash_index(hash_index):
    """Save perceptual hash index."""
    with open(HASH_FILE, 'w') as f:
        json.dump(hash_index, f)


def load_names_db():
    """Load named face database: list of {name, embeddings, created_at, updated_at}."""
    if os.path.exists(NAMES_FILE):
        try:
            with open(NAMES_FILE, 'rb') as f:
                return pickle.load(f)
        except Exception:
            pass
    return []


def save_names_db(names_db):
    """Save named face database."""
    with open(NAMES_FILE, 'wb') as f:
        pickle.dump(names_db, f, protocol=pickle.HIGHEST_PROTOCOL)


def match_name_for_embedding(centroid, names_db, threshold=0.45):
    """Find best matching name for a face embedding centroid.
    Returns (name, similarity) or (None, 0.0)."""
    best_name = None
    best_sim = 0.0
    for entry in names_db:
        for emb in entry['embeddings']:
            emb_norm = emb / np.linalg.norm(emb) if np.linalg.norm(emb) > 0 else emb
            sim = float(np.dot(centroid, emb_norm))
            if sim > best_sim:
                best_sim = sim
                best_name = entry['name']
    if best_sim >= threshold:
        return best_name, best_sim
    return None, 0.0


def is_good_face(bbox, landmarks, min_size=MIN_FACE_SIZE):
    """
    Filter out low-quality face detections and return True only for usable faces.

    Uses 5-point landmarks: [left_eye, right_eye, nose, left_mouth, right_mouth]

    Checks performed:
      #1 Minimum size      — Rejects tiny/distant faces (< 40px). Too small to
                             produce reliable embeddings for recognition.
      #2 Aspect ratio      — Rejects abnormally wide or tall bounding boxes
                             (ratio < 0.5 or > 2.0). Real faces are roughly
                             square; extreme ratios indicate false detections
                             on elongated objects like banners or text.
      #3 Landmarks in bbox — Rejects detections where facial landmarks fall far
                             outside the bounding box (30% margin). Catches false
                             positives on flags, patterns, and background textures
                             where the detector fires but landmarks land elsewhere.
      #4 Landmark spread   — Rejects detections where all 5 landmarks are bunched
                             into a tiny cluster (< 5% of face dimensions). False
                             detections on uniform textures produce landmarks that
                             collapse to nearly the same point.
      #5 Mouth below nose  — Rejects detections where the mouth center is above
                             the nose. Catches upside-down or severely malformed
                             detections that don't represent a valid face orientation.
      #6 Eyes above nose   — Rejects detections where the eye center is below the
                             nose (with 10% tolerance). Catches inverted or warped
                             detections where facial structure is nonsensical.
      #7 Vertical spread   — Rejects detections where the eyes-to-mouth distance
                             covers less than 15% of the bbox height. Catches
                             back-of-head, top-of-head, and heavily downward-facing
                             detections where all features compress into a thin band
                             because the actual face is not visible.
    """
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1

    # #1 Minimum size — reject tiny/distant faces that can't produce
    #    reliable embeddings (below 40px width or height).
    if w < min_size or h < min_size:
        return False

    # #2 Aspect ratio — reject abnormally shaped bounding boxes.
    #    Real faces have ratio ~0.7-1.3; anything outside 0.5-2.0 is
    #    likely a false detection on banners, text, or elongated objects.
    aspect = w / max(h, 1)
    if aspect < 0.5 or aspect > 2.0:
        return False

    if landmarks is None:
        return False

    left_eye = landmarks[0]
    right_eye = landmarks[1]
    nose = landmarks[2]
    left_mouth = landmarks[3]
    right_mouth = landmarks[4]

    # #3 Landmarks in bbox — all 5 points should fall within or close to
    #    the bounding box (30% margin). False positives on flags, patterns,
    #    and backgrounds produce landmarks that scatter far outside the bbox.
    margin = max(w, h) * 0.3
    all_pts = [left_eye, right_eye, nose, left_mouth, right_mouth]
    for pt in all_pts:
        if pt[0] < x1 - margin or pt[0] > x2 + margin or pt[1] < y1 - margin or pt[1] > y2 + margin:
            return False

    # #4 Landmark spread — reject detections where all landmarks cluster
    #    into a tiny area (< 5% of face size in both axes). False detections
    #    on uniform textures/solid colors collapse all points to one spot.
    pts = np.array(all_pts)
    spread = np.std(pts, axis=0)
    if spread[0] < w * 0.05 and spread[1] < h * 0.05:
        return False

    # #5 Mouth below nose — the mouth center must be below the nose tip.
    #    Violations indicate upside-down or severely malformed detections.
    mouth_center_y = (left_mouth[1] + right_mouth[1]) / 2
    if mouth_center_y < nose[1]:
        return False

    # #6 Eyes above nose — the eye center must be above the nose tip
    #    (with 10% tolerance for slight tilts). Violations indicate
    #    inverted or warped detections with nonsensical face structure.
    eye_center_y = (left_eye[1] + right_eye[1]) / 2
    if eye_center_y > nose[1] + h * 0.1:
        return False

    # #7 Vertical spread — the distance from eyes to mouth must cover at
    #    least 15% of the bbox height. Back-of-head, top-of-head, and
    #    heavily downward-facing detections compress all features into a
    #    thin horizontal band because the actual face is not visible.
    feature_height = mouth_center_y - eye_center_y
    if feature_height < h * 0.15:
        return False

    return True


class FaceDetector:
    """SCRFD face detector using ONNX Runtime."""

    def __init__(self, model_path):
        self.session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        self.input_size = (640, 640)
        self.fmc = 3  # Feature map count
        self.feat_stride_fpn = [8, 16, 32]
        self.num_anchors = 2

    def detect(self, img, threshold=0.5):
        """Detect faces, return list of (bbox, score, landmarks)."""
        h, w = img.shape[:2]
        # Resize with letterbox
        scale = min(self.input_size[0] / h, self.input_size[1] / w)
        new_h, new_w = int(h * scale), int(w * scale)
        resized = cv2.resize(img, (new_w, new_h))

        # Pad to input_size
        padded = np.full((self.input_size[0], self.input_size[1], 3), 127.5, dtype=np.float32)
        padded[:new_h, :new_w, :] = resized.astype(np.float32)

        # Normalize
        blob = (padded - 127.5) / 128.0
        blob = blob.transpose(2, 0, 1)[np.newaxis, ...]  # NCHW
        blob = blob.astype(np.float32)

        # Run inference
        outputs = self.session.run(None, {self.input_name: blob})

        # Parse outputs: for SCRFD with 3 strides, outputs are:
        # [scores_8, bbox_8, kps_8, scores_16, bbox_16, kps_16, scores_32, bbox_32, kps_32]
        bboxes_list = []
        scores_list = []
        kps_list = []

        for idx, stride in enumerate(self.feat_stride_fpn):
            # Outputs are grouped by type: [scores_s8, scores_s16, scores_s32, bbox_s8, bbox_s16, bbox_s32, kps_s8, kps_s16, kps_s32]
            score_blob = outputs[idx]
            bbox_blob = outputs[self.fmc + idx]
            kps_blob = outputs[2 * self.fmc + idx] if len(outputs) > 2 * self.fmc + idx else None

            scores = score_blob.reshape(-1)
            bboxes = bbox_blob.reshape(-1, 4)

            # Generate anchors to match actual output size
            num_anchors_total = len(scores)
            fh = self.input_size[0] // stride
            fw = self.input_size[1] // stride
            actual_num_anchors = num_anchors_total // (fh * fw)
            anchors = self._generate_anchors(fh, fw, stride, actual_num_anchors)

            # Filter by threshold
            mask = scores > threshold
            if not np.any(mask):
                continue

            scores = scores[mask]
            bboxes = bboxes[mask]
            anchors_filtered = anchors[mask]

            # Decode bboxes (distance to ltrb)
            x1 = anchors_filtered[:, 0] - bboxes[:, 0] * stride
            y1 = anchors_filtered[:, 1] - bboxes[:, 1] * stride
            x2 = anchors_filtered[:, 0] + bboxes[:, 2] * stride
            y2 = anchors_filtered[:, 1] + bboxes[:, 3] * stride
            decoded = np.stack([x1, y1, x2, y2], axis=1)

            bboxes_list.append(decoded)
            scores_list.append(scores)

            # Decode keypoints
            if kps_blob is not None:
                kps = kps_blob.reshape(-1, 10)[mask]
                kps_decoded = np.zeros_like(kps)
                for k in range(5):
                    kps_decoded[:, k * 2] = anchors_filtered[:, 0] + kps[:, k * 2] * stride
                    kps_decoded[:, k * 2 + 1] = anchors_filtered[:, 1] + kps[:, k * 2 + 1] * stride
                kps_list.append(kps_decoded)

        if not bboxes_list:
            return []

        all_bboxes = np.vstack(bboxes_list)
        all_scores = np.concatenate(scores_list)
        all_kps = np.vstack(kps_list) if kps_list else None

        # Scale back to original image
        all_bboxes /= scale
        if all_kps is not None:
            all_kps /= scale

        # NMS
        keep = self._nms(all_bboxes, all_scores, 0.4)

        results = []
        for i in keep:
            bbox = all_bboxes[i].astype(int)
            score = float(all_scores[i])
            kps = all_kps[i].reshape(5, 2) if all_kps is not None else None
            results.append((bbox, score, kps))

        return results

    def _generate_anchors(self, fh, fw, stride, num_anchors=None):
        """Generate anchor centers for a given feature map."""
        if num_anchors is None:
            num_anchors = self.num_anchors
        anchors = []
        for i in range(fh):
            for j in range(fw):
                cx = j * stride + stride // 2
                cy = i * stride + stride // 2
                for _ in range(num_anchors):
                    anchors.append([cx, cy])
        return np.array(anchors, dtype=np.float32)

    def _nms(self, bboxes, scores, threshold):
        """Non-maximum suppression."""
        x1 = bboxes[:, 0]
        y1 = bboxes[:, 1]
        x2 = bboxes[:, 2]
        y2 = bboxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)

        order = scores.argsort()[::-1]
        keep = []

        while order.size > 0:
            i = order[0]
            keep.append(i)

            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])

            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h

            ovr = inter / (areas[i] + areas[order[1:]] - inter)
            inds = np.where(ovr <= threshold)[0]
            order = order[inds + 1]

        return keep


class FaceRecognizer:
    """ArcFace face recognition using ONNX Runtime."""

    def __init__(self, model_path):
        self.session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        self.input_size = (112, 112)

    def get_embedding(self, img, landmarks):
        """Get face embedding from aligned face."""
        aligned = self._align_face(img, landmarks)
        # Preprocess
        blob = cv2.dnn.blobFromImage(aligned, 1.0 / 127.5, self.input_size, (127.5, 127.5, 127.5), swapRB=True)
        # Run inference
        embedding = self.session.run(None, {self.input_name: blob})[0][0]
        return embedding

    def _align_face(self, img, landmarks):
        """Align face using 5-point landmarks to standard ArcFace template."""
        src = landmarks.astype(np.float32)
        dst = ARCFACE_DST.copy()

        # Estimate affine transform
        tform = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)[0]
        if tform is None:
            # Fallback: use full affine
            tform = cv2.getAffineTransform(src[:3], dst[:3])

        aligned = cv2.warpAffine(img, tform, self.input_size, borderValue=0.0)
        return aligned


def collect_image_files():
    """Collect all image files from all scraper news_images directories."""
    files = []
    for img_dir in IMAGE_DIRS:
        if not os.path.isdir(img_dir):
            continue
        for fname in os.listdir(img_dir):
            ext = os.path.splitext(fname)[1].lower()
            if ext in VALID_EXTENSIONS:
                files.append((fname, os.path.join(img_dir, fname)))
    return files


def check_models():
    """Check that required model files exist."""
    if not os.path.exists(DET_MODEL):
        print(f"Error: Detection model not found: {DET_MODEL}", file=sys.stderr)
        print("Download buffalo_l models from: https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip", file=sys.stderr)
        print(f"Extract to: {MODEL_DIR}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(REC_MODEL):
        print(f"Error: Recognition model not found: {REC_MODEL}", file=sys.stderr)
        sys.exit(1)


def load_processed_files():
    """Load the set of all previously processed filenames (including those with no faces)."""
    if os.path.exists(PROCESSED_FILE):
        try:
            with open(PROCESSED_FILE, 'r') as f:
                return set(json.load(f))
        except Exception:
            pass
    # Fallback: derive from index (old data before processed file existed)
    if os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE, 'rb') as f:
                data = pickle.load(f)
            return {entry['image'] for entry in data}
        except Exception:
            pass
    return set()


def save_processed_files(processed):
    """Save the set of all processed filenames."""
    with open(PROCESSED_FILE, 'w') as f:
        json.dump(sorted(processed), f)


def check_new_images():
    """Quickly check how many new (unprocessed) images exist. No model loading."""
    processed = load_processed_files()
    all_files = collect_image_files()
    new_count = sum(1 for name, _ in all_files if name not in processed)
    result = {
        'total_images': len(all_files),
        'processed_images': len(processed),
        'new_images': new_count,
    }
    print(json.dumps(result))


def build_index():
    """Build or incrementally update the face embedding index."""
    # Load existing index and processed file list (lightweight, no models)
    existing_data = []
    if os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE, 'rb') as f:
                existing_data = pickle.load(f)
            print(f"Loaded existing index: {len(existing_data)} face entries", flush=True)
        except Exception as e:
            print(f"Warning: Could not load existing index, rebuilding: {e}", flush=True)
            existing_data = []

    processed_files = load_processed_files()

    # Check for new images BEFORE loading heavy models
    all_files = collect_image_files()
    new_files = [(name, path) for name, path in all_files if name not in processed_files]
    print(f"Total images: {len(all_files)}, Already processed: {len(processed_files)}, New: {len(new_files)}", flush=True)

    if not new_files:
        print("Index is up to date. No new images to process.", flush=True)
        images_with_faces = len({e['image'] for e in existing_data})
        save_metadata(len(existing_data), images_with_faces)
        return

    # Load perceptual hash index for duplicate detection
    hash_index = load_hash_index()

    # Only load models when there are actual new images
    check_models()
    print("Loading models...", flush=True)
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)
    print("Models loaded.", flush=True)

    # Process new images
    new_entries = []
    faces_found = 0
    duplicates_skipped = 0
    errors = 0

    for i, (fname, fpath) in enumerate(new_files):
        if (i + 1) % 50 == 0 or i == 0:
            print(f"Processing {i + 1}/{len(new_files)}: {fname}", flush=True)

        try:
            img = cv2.imread(fpath)
            if img is None:
                processed_files.add(fname)
                continue

            # Duplicate detection via perceptual hash
            phash = compute_phash(img)
            is_dup = False
            for existing_hash, existing_fname in hash_index.items():
                if hamming_distance(phash, existing_hash) < 6:
                    duplicates_skipped += 1
                    is_dup = True
                    break
            if is_dup:
                processed_files.add(fname)
                continue

            hash_index[phash] = fname

            faces = detector.detect(img, threshold=0.5)
            for bbox, score, landmarks in faces:
                if landmarks is None:
                    continue
                if not is_good_face(bbox, landmarks):
                    continue
                embedding = recognizer.get_embedding(img, landmarks)
                if embedding is not None:
                    new_entries.append({
                        'image': fname,
                        'embedding': embedding.astype(np.float32),
                        'bbox': bbox.tolist(),
                    })
                    faces_found += 1
            # Mark as processed regardless of whether faces were found
            processed_files.add(fname)
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"Error processing {fname}: {e}", flush=True)
            processed_files.add(fname)

    # Merge and save face index
    all_data = existing_data + new_entries
    with open(INDEX_FILE, 'wb') as f:
        pickle.dump(all_data, f, protocol=pickle.HIGHEST_PROTOCOL)

    # Save processed files list and hash index
    save_processed_files(processed_files)
    save_hash_index(hash_index)

    images_with_faces = len({e['image'] for e in all_data})
    save_metadata(len(all_data), images_with_faces)

    print(f"\nIndex updated:", flush=True)
    print(f"  New faces found: {faces_found}", flush=True)
    print(f"  Duplicates skipped: {duplicates_skipped}", flush=True)
    print(f"  Total faces in index: {len(all_data)}", flush=True)
    print(f"  Total images indexed: {images_with_faces}", flush=True)
    print(f"  Errors: {errors}", flush=True)


def save_metadata(face_count, image_count):
    """Save index metadata as JSON for the Node.js server to read."""
    meta = {
        'face_count': face_count,
        'image_count': image_count,
        'last_updated': time.strftime('%Y-%m-%d %H:%M:%S'),
        'index_size_mb': round(os.path.getsize(INDEX_FILE) / (1024 * 1024), 2) if os.path.exists(INDEX_FILE) else 0,
    }
    with open(META_FILE, 'w') as f:
        json.dump(meta, f, indent=2)


def search(image_path, threshold=0.4, limit=20):
    """Search for matching faces in the index."""
    if not os.path.exists(INDEX_FILE):
        print(json.dumps({'error': 'Face index not found. Please build the index first.'}))
        sys.exit(0)

    # Load index
    with open(INDEX_FILE, 'rb') as f:
        index_data = pickle.load(f)

    if not index_data:
        print(json.dumps({'error': 'Face index is empty. Please build the index first.'}))
        sys.exit(0)

    check_models()

    # Load models and get query face
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)

    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps({'error': f'Could not read image: {image_path}'}))
        sys.exit(0)

    faces = detector.detect(img, threshold=0.5)
    if not faces:
        print(json.dumps({'error': 'No face detected in the uploaded image.'}))
        sys.exit(0)

    # Use the largest face in the uploaded image
    largest = max(faces, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
    bbox, score, landmarks = largest

    if landmarks is None:
        print(json.dumps({'error': 'Could not detect face landmarks in the uploaded image.'}))
        sys.exit(0)

    query_embedding = recognizer.get_embedding(img, landmarks)

    # Normalize query embedding
    query_norm = query_embedding / np.linalg.norm(query_embedding)

    # Build matrix of all indexed embeddings for fast comparison
    all_embeddings = np.array([entry['embedding'] for entry in index_data], dtype=np.float32)
    norms = np.linalg.norm(all_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    all_embeddings_norm = all_embeddings / norms

    # Cosine similarity
    similarities = np.dot(all_embeddings_norm, query_norm)

    # Filter and sort
    matches = []
    seen_images = set()
    sorted_indices = np.argsort(similarities)[::-1]

    for idx in sorted_indices:
        score = float(similarities[idx])
        if score < threshold:
            break

        entry = index_data[idx]
        image_name = entry['image']

        # Keep best match per image
        if image_name in seen_images:
            continue
        seen_images.add(image_name)

        matches.append({
            'image': image_name,
            'score': round(score, 4),
            'bbox': entry['bbox'],
        })

        if len(matches) >= limit:
            break

    print(json.dumps(matches))


def search_multi(image_paths, threshold=0.4, limit=20, strategy='hybrid'):
    """
    Search for matching faces using multiple query images.

    Args:
        image_paths: List of paths to query images
        threshold: Similarity threshold (0-1)
        limit: Max results to return
        strategy: 'average', 'max', or 'hybrid' (default)
    """
    if not os.path.exists(INDEX_FILE):
        print(json.dumps({'error': 'Face index not found. Please build the index first.'}))
        sys.exit(0)

    # Load index
    with open(INDEX_FILE, 'rb') as f:
        index_data = pickle.load(f)

    if not index_data:
        print(json.dumps({'error': 'Face index is empty. Please build the index first.'}))
        sys.exit(0)

    check_models()

    # Load models
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)

    # Extract embeddings from all query images
    query_embeddings = []
    query_confidences = []

    for image_path in image_paths:
        img = cv2.imread(image_path)
        if img is None:
            continue

        faces = detector.detect(img, threshold=0.5)
        if not faces:
            continue

        # Use the largest face
        largest = max(faces, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
        bbox, score, landmarks = largest

        if landmarks is None:
            continue

        embedding = recognizer.get_embedding(img, landmarks)
        query_embeddings.append(embedding)
        query_confidences.append(score)

    if not query_embeddings:
        print(json.dumps({'error': 'No faces detected in any of the uploaded images.'}))
        sys.exit(0)

    # Normalize all query embeddings
    query_embeddings = np.array(query_embeddings, dtype=np.float32)
    query_norms = np.linalg.norm(query_embeddings, axis=1, keepdims=True)
    query_norms[query_norms == 0] = 1
    query_embeddings_norm = query_embeddings / query_norms

    # Build matrix of all indexed embeddings
    all_embeddings = np.array([entry['embedding'] for entry in index_data], dtype=np.float32)
    norms = np.linalg.norm(all_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    all_embeddings_norm = all_embeddings / norms

    # Calculate similarities based on strategy
    if strategy == 'average':
        # Average embeddings (weighted by confidence)
        confidences = np.array(query_confidences, dtype=np.float32)
        weights = confidences / confidences.sum()
        avg_embedding = np.average(query_embeddings_norm, axis=0, weights=weights)
        avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
        similarities = np.dot(all_embeddings_norm, avg_embedding)

    elif strategy == 'max':
        # Maximum similarity across all query embeddings
        all_sims = np.dot(all_embeddings_norm, query_embeddings_norm.T)
        similarities = np.max(all_sims, axis=1)

    else:  # hybrid (default)
        # Combine average and max strategies
        # Average embeddings
        confidences = np.array(query_confidences, dtype=np.float32)
        weights = confidences / confidences.sum()
        avg_embedding = np.average(query_embeddings_norm, axis=0, weights=weights)
        avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
        avg_similarities = np.dot(all_embeddings_norm, avg_embedding)

        # Max similarities
        all_sims = np.dot(all_embeddings_norm, query_embeddings_norm.T)
        max_similarities = np.max(all_sims, axis=1)

        # Weighted combination (70% average, 30% max)
        similarities = 0.7 * avg_similarities + 0.3 * max_similarities

    # Filter and sort
    matches = []
    seen_images = set()
    sorted_indices = np.argsort(similarities)[::-1]

    for idx in sorted_indices:
        score = float(similarities[idx])
        if score < threshold:
            break

        entry = index_data[idx]
        image_name = entry['image']

        # Keep best match per image
        if image_name in seen_images:
            continue
        seen_images.add(image_name)

        matches.append({
            'image': image_name,
            'score': round(score, 4),
            'bbox': entry['bbox'],
        })

        if len(matches) >= limit:
            break

    print(json.dumps(matches))


def relation_search(image_paths, threshold=0.4, strategy='hybrid', cluster_threshold=0.35):
    """
    Find people who frequently appear in the same images as the target person.

    1. Find target person embedding (multi-image fusion)
    2. Find all images containing the target
    3. Collect all OTHER faces from those images
    4. Cluster non-target faces by identity
    5. Return clusters with >= 2 co-appearances, sorted by count
    """
    if not os.path.exists(INDEX_FILE):
        print(json.dumps({'error': 'Face index not found. Please build the index first.'}))
        sys.exit(0)

    with open(INDEX_FILE, 'rb') as f:
        index_data = pickle.load(f)

    if not index_data:
        print(json.dumps({'error': 'Face index is empty. Please build the index first.'}))
        sys.exit(0)

    check_models()
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)

    # --- Step 1: Get target embedding(s) ---
    query_embeddings = []
    query_confidences = []

    for image_path in image_paths:
        img = cv2.imread(image_path)
        if img is None:
            continue
        faces = detector.detect(img, threshold=0.5)
        if not faces:
            continue
        largest = max(faces, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
        bbox, score, landmarks = largest
        if landmarks is None:
            continue
        embedding = recognizer.get_embedding(img, landmarks)
        query_embeddings.append(embedding)
        query_confidences.append(score)

    if not query_embeddings:
        print(json.dumps({'error': 'No faces detected in any of the uploaded images.'}))
        sys.exit(0)

    # Fuse target embeddings (hybrid strategy)
    query_embeddings = np.array(query_embeddings, dtype=np.float32)
    query_norms = np.linalg.norm(query_embeddings, axis=1, keepdims=True)
    query_norms[query_norms == 0] = 1
    query_embeddings_norm = query_embeddings / query_norms

    # Build normalized index embeddings
    all_embeddings = np.array([entry['embedding'] for entry in index_data], dtype=np.float32)
    norms = np.linalg.norm(all_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    all_embeddings_norm = all_embeddings / norms

    # Compute similarities using chosen strategy
    if strategy == 'average':
        confidences = np.array(query_confidences, dtype=np.float32)
        weights = confidences / confidences.sum()
        avg_embedding = np.average(query_embeddings_norm, axis=0, weights=weights)
        avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
        similarities = np.dot(all_embeddings_norm, avg_embedding)
    elif strategy == 'max':
        all_sims = np.dot(all_embeddings_norm, query_embeddings_norm.T)
        similarities = np.max(all_sims, axis=1)
    else:  # hybrid
        confidences = np.array(query_confidences, dtype=np.float32)
        weights = confidences / confidences.sum()
        avg_embedding = np.average(query_embeddings_norm, axis=0, weights=weights)
        avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
        avg_similarities = np.dot(all_embeddings_norm, avg_embedding)
        all_sims = np.dot(all_embeddings_norm, query_embeddings_norm.T)
        max_similarities = np.max(all_sims, axis=1)
        similarities = 0.7 * avg_similarities + 0.3 * max_similarities

    # --- Step 2: Group index entries by image, find target images ---
    image_entries = {}  # image_name -> list of (index_idx, entry, similarity)
    for idx, entry in enumerate(index_data):
        img_name = entry['image']
        if img_name not in image_entries:
            image_entries[img_name] = []
        image_entries[img_name].append((idx, entry, float(similarities[idx])))

    # For each image, check if the best-matching face exceeds threshold
    target_images = {}  # image_name -> (target_idx, target_sim, non_target_entries)
    for img_name, entries in image_entries.items():
        best = max(entries, key=lambda x: x[2])
        best_idx, best_entry, best_sim = best
        if best_sim >= threshold:
            non_targets = [(idx, e) for idx, e, sim in entries if idx != best_idx]
            if non_targets:  # Only include images that have OTHER faces
                target_images[img_name] = {
                    'target_idx': best_idx,
                    'target_sim': best_sim,
                    'target_bbox': best_entry['bbox'],
                    'non_targets': non_targets,
                }

    if not target_images:
        print(json.dumps({
            'target_images': 0,
            'associates': [],
            'message': 'Target person found but no other people appear in the same images.',
        }))
        sys.exit(0)

    # --- Step 3: Collect all non-target faces ---
    non_target_faces = []  # list of {embedding_norm, image, bbox, target_bbox, target_sim}
    for img_name, info in target_images.items():
        for idx, entry in info['non_targets']:
            non_target_faces.append({
                'embedding_norm': all_embeddings_norm[idx],
                'image': img_name,
                'bbox': entry['bbox'],
                'target_bbox': info['target_bbox'],
                'target_sim': info['target_sim'],
            })

    # --- Step 4: Cluster non-target faces by identity ---
    clusters = []  # list of {centroid, embeddings, members}

    for face in non_target_faces:
        emb = face['embedding_norm']
        best_cluster_idx = -1
        best_sim = 0.0

        # Compare against all members in each cluster (not just centroid)
        # to avoid centroid drift causing missed matches
        for i, cluster in enumerate(clusters):
            # Check similarity against centroid first (fast path)
            centroid_sim = float(np.dot(cluster['centroid'], emb))
            if centroid_sim > best_sim:
                best_sim = centroid_sim
                best_cluster_idx = i
            # Also check max similarity against any member in the cluster
            # No gate — always check all members to avoid missed assignments
            for member_emb in cluster['embeddings']:
                member_sim = float(np.dot(member_emb, emb))
                if member_sim > best_sim:
                    best_sim = member_sim
                    best_cluster_idx = i

        if best_sim >= cluster_threshold and best_cluster_idx >= 0:
            cluster = clusters[best_cluster_idx]
            cluster['members'].append(face)
            cluster['embeddings'].append(emb)
            # Recompute centroid from all embeddings (avoids drift)
            all_embs = np.array(cluster['embeddings'])
            new_centroid = np.mean(all_embs, axis=0)
            norm = np.linalg.norm(new_centroid)
            if norm > 0:
                new_centroid = new_centroid / norm
            cluster['centroid'] = new_centroid
        else:
            clusters.append({
                'centroid': emb.copy(),
                'embeddings': [emb],
                'members': [face],
            })

    # --- Step 4b: Merge clusters that represent the same person ---
    # Clusters may have formed separately due to processing order.
    # Check both centroid similarity AND member-to-member similarity
    # to catch cases where centroids diverge but individual faces match.
    merged = True
    while merged:
        merged = False
        i = 0
        while i < len(clusters):
            j = i + 1
            while j < len(clusters):
                should_merge = False
                # Fast check: centroid similarity
                centroid_sim = float(np.dot(clusters[i]['centroid'], clusters[j]['centroid']))
                if centroid_sim >= cluster_threshold:
                    should_merge = True
                else:
                    # Slow check: any member from i matches any member from j
                    # No gate — always check, since centroids can diverge
                    # even when individual faces clearly match
                    for emb_i in clusters[i]['embeddings']:
                        for emb_j in clusters[j]['embeddings']:
                            if float(np.dot(emb_i, emb_j)) >= cluster_threshold:
                                should_merge = True
                                break
                        if should_merge:
                            break

                if should_merge:
                    # Merge cluster j into cluster i
                    clusters[i]['members'].extend(clusters[j]['members'])
                    clusters[i]['embeddings'].extend(clusters[j]['embeddings'])
                    all_embs = np.array(clusters[i]['embeddings'])
                    new_centroid = np.mean(all_embs, axis=0)
                    norm = np.linalg.norm(new_centroid)
                    if norm > 0:
                        new_centroid = new_centroid / norm
                    clusters[i]['centroid'] = new_centroid
                    clusters.pop(j)
                    merged = True
                else:
                    j += 1
            i += 1

    # --- Step 4c: Load saved names for auto-tagging ---
    names_db = load_names_db()

    # --- Step 5: Filter clusters with >= 2 members, sort by count ---
    # Deduplicate: same person might have multiple faces in one image,
    # AND same photo from different scrapers (different filename, same content)
    filtered = []
    for i, cluster in enumerate(clusters):
        unique_images = {}
        for member in cluster['members']:
            img = member['image']
            if img not in unique_images:
                unique_images[img] = member

        # Remove near-duplicate images (same photo from different scrapers)
        # by checking embedding similarity between members
        deduped = []
        for member in unique_images.values():
            is_dup = False
            for existing in deduped:
                sim = float(np.dot(member['embedding_norm'], existing['embedding_norm']))
                if sim > 0.95:
                    is_dup = True
                    break
            if not is_dup:
                deduped.append(member)

        if len(deduped) >= 2:
            members_list = deduped
            # Pick representative: the member from the image with highest target similarity
            representative = max(members_list, key=lambda m: m['target_sim'])

            # Auto-tag: match cluster centroid against saved names
            matched_name, name_sim = match_name_for_embedding(cluster['centroid'], names_db)

            entry = {
                'id': i,
                'count': len(deduped),
                'representative': {
                    'image': representative['image'],
                    'bbox': representative['bbox'],
                },
                'images': [
                    {
                        'image': m['image'],
                        'assoc_bbox': m['bbox'],
                        'target_bbox': m['target_bbox'],
                        'cluster_sim': round(float(np.dot(cluster['centroid'], m['embedding_norm'])), 4),
                    }
                    for m in members_list
                ],
            }
            if matched_name:
                entry['name'] = matched_name
                entry['name_sim'] = round(name_sim, 4)

            filtered.append(entry)

    filtered.sort(key=lambda x: x['count'], reverse=True)

    # Re-assign IDs after sorting
    for i, assoc in enumerate(filtered):
        assoc['id'] = i

    # Count total images where target was found (including those without other faces)
    total_target_count = sum(
        1 for entries in image_entries.values()
        if max(e[2] for e in entries) >= threshold
    )

    print(json.dumps({
        'target_images': total_target_count,
        'associates': filtered,
    }))


def pair_search(images_a, images_b, threshold=0.4):
    """
    Find all indexed images where person A and person B appear together.

    Args:
        images_a: List of image paths for person A
        images_b: List of image paths for person B
        threshold: Similarity threshold for face matching
    """
    if not os.path.exists(INDEX_FILE):
        print(json.dumps({'error': 'Face index not found. Please build the index first.'}))
        sys.exit(0)

    with open(INDEX_FILE, 'rb') as f:
        index_data = pickle.load(f)

    if not index_data:
        print(json.dumps({'error': 'Face index is empty. Please build the index first.'}))
        sys.exit(0)

    check_models()
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)

    def extract_embeddings(image_paths):
        embeddings = []
        confidences = []
        for image_path in image_paths:
            img = cv2.imread(image_path)
            if img is None:
                continue
            faces = detector.detect(img, threshold=0.5)
            if not faces:
                continue
            largest = max(faces, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
            bbox, score, landmarks = largest
            if landmarks is None:
                continue
            embedding = recognizer.get_embedding(img, landmarks)
            if embedding is not None:
                embeddings.append(embedding.astype(np.float32))
                confidences.append(score)
        return embeddings, confidences

    embs_a, confs_a = extract_embeddings(images_a)
    embs_b, confs_b = extract_embeddings(images_b)

    if not embs_a:
        print(json.dumps({'error': 'No faces detected in Person A images.'}))
        sys.exit(0)
    if not embs_b:
        print(json.dumps({'error': 'No faces detected in Person B images.'}))
        sys.exit(0)

    # Normalize query embeddings
    embs_a = np.array(embs_a, dtype=np.float32)
    norms_a = np.linalg.norm(embs_a, axis=1, keepdims=True)
    norms_a[norms_a == 0] = 1
    embs_a_norm = embs_a / norms_a

    embs_b = np.array(embs_b, dtype=np.float32)
    norms_b = np.linalg.norm(embs_b, axis=1, keepdims=True)
    norms_b[norms_b == 0] = 1
    embs_b_norm = embs_b / norms_b

    # Build fused query embeddings (hybrid: 70% avg + 30% max)
    def fuse_embeddings(embs_norm, confs):
        weights = np.array(confs, dtype=np.float32)
        weights = weights / weights.sum()
        avg_emb = np.average(embs_norm, axis=0, weights=weights)
        avg_emb = avg_emb / np.linalg.norm(avg_emb)
        return avg_emb, embs_norm

    avg_a, all_a = fuse_embeddings(embs_a_norm, confs_a)
    avg_b, all_b = fuse_embeddings(embs_b_norm, confs_b)

    # Build index matrix
    all_embeddings = np.array([e['embedding'] for e in index_data], dtype=np.float32)
    norms = np.linalg.norm(all_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    all_embeddings_norm = all_embeddings / norms

    # Compute similarities for A and B against all index faces
    # Hybrid: 70% average + 30% max
    avg_sims_a = np.dot(all_embeddings_norm, avg_a)
    max_sims_a = np.max(np.dot(all_embeddings_norm, all_a.T), axis=1)
    sims_a = 0.7 * avg_sims_a + 0.3 * max_sims_a

    avg_sims_b = np.dot(all_embeddings_norm, avg_b)
    max_sims_b = np.max(np.dot(all_embeddings_norm, all_b.T), axis=1)
    sims_b = 0.7 * avg_sims_b + 0.3 * max_sims_b

    # Group index entries by image
    image_faces = {}  # image_name -> list of (idx, entry, sim_a, sim_b)
    for idx, entry in enumerate(index_data):
        img_name = entry['image']
        if img_name not in image_faces:
            image_faces[img_name] = []
        image_faces[img_name].append({
            'idx': idx,
            'entry': entry,
            'sim_a': float(sims_a[idx]),
            'sim_b': float(sims_b[idx]),
        })

    # Find images where BOTH person A and person B have a matching face
    results = []
    for img_name, faces in image_faces.items():
        best_a = max(faces, key=lambda f: f['sim_a'])
        best_b = None
        best_b_sim = 0.0
        # Person B must be a DIFFERENT face than person A's best match
        for f in faces:
            if f['idx'] != best_a['idx'] and f['sim_b'] > best_b_sim:
                best_b_sim = f['sim_b']
                best_b = f

        if best_a['sim_a'] >= threshold and best_b is not None and best_b['sim_b'] >= threshold:
            results.append({
                'image': img_name,
                'score_a': round(best_a['sim_a'], 4),
                'score_b': round(best_b['sim_b'], 4),
                'bbox_a': best_a['entry']['bbox'],
                'bbox_b': best_b['entry']['bbox'],
            })

    # Sort by combined score
    results.sort(key=lambda x: x['score_a'] + x['score_b'], reverse=True)

    print(json.dumps({
        'matches': results,
        'count': len(results),
    }))


def save_name(name, image_paths):
    """Save a named face identity from one or more images."""
    check_models()
    detector = FaceDetector(DET_MODEL)
    recognizer = FaceRecognizer(REC_MODEL)

    embeddings = []
    for image_path in image_paths:
        img = cv2.imread(image_path)
        if img is None:
            continue
        faces = detector.detect(img, threshold=0.5)
        if not faces:
            continue
        largest = max(faces, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
        bbox, score, landmarks = largest
        if landmarks is None:
            continue
        embedding = recognizer.get_embedding(img, landmarks)
        if embedding is not None:
            embeddings.append(embedding.astype(np.float32))

    if not embeddings:
        print(json.dumps({'error': 'No faces detected in any of the uploaded images.'}))
        sys.exit(0)

    names_db = load_names_db()

    # Check if name already exists — update it
    found = False
    for entry in names_db:
        if entry['name'].lower() == name.lower():
            entry['embeddings'] = embeddings
            entry['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
            found = True
            break

    if not found:
        names_db.append({
            'name': name,
            'embeddings': embeddings,
            'created_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
        })

    save_names_db(names_db)
    print(json.dumps({'success': True, 'name': name, 'face_count': len(embeddings)}))


def list_names():
    """List all saved named faces."""
    names_db = load_names_db()
    result = []
    for entry in names_db:
        result.append({
            'name': entry['name'],
            'face_count': len(entry['embeddings']),
            'created_at': entry.get('created_at', ''),
            'updated_at': entry.get('updated_at', ''),
        })
    print(json.dumps(result))


def delete_name(name):
    """Delete a named face identity."""
    names_db = load_names_db()
    original_len = len(names_db)
    names_db = [e for e in names_db if e['name'].lower() != name.lower()]
    save_names_db(names_db)
    deleted = original_len - len(names_db)
    print(json.dumps({'success': deleted > 0, 'deleted': deleted}))


def search_by_name(name, threshold=0.4, limit=20):
    """Search for a person by their saved name."""
    names_db = load_names_db()
    target = None
    for entry in names_db:
        if entry['name'].lower() == name.lower():
            target = entry
            break

    if target is None:
        print(json.dumps({'error': f'Name "{name}" not found in database.'}))
        sys.exit(0)

    if not os.path.exists(INDEX_FILE):
        print(json.dumps({'error': 'Face index not found. Please build the index first.'}))
        sys.exit(0)

    with open(INDEX_FILE, 'rb') as f:
        index_data = pickle.load(f)

    if not index_data:
        print(json.dumps({'error': 'Face index is empty.'}))
        sys.exit(0)

    # Normalize stored embeddings
    embeddings = np.array(target['embeddings'], dtype=np.float32)
    emb_norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    emb_norms[emb_norms == 0] = 1
    embeddings_norm = embeddings / emb_norms

    # Build index matrix
    all_embeddings = np.array([entry['embedding'] for entry in index_data], dtype=np.float32)
    norms = np.linalg.norm(all_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    all_embeddings_norm = all_embeddings / norms

    # Hybrid search: 70% average + 30% max
    avg_embedding = np.mean(embeddings_norm, axis=0)
    avg_embedding = avg_embedding / np.linalg.norm(avg_embedding)
    avg_sims = np.dot(all_embeddings_norm, avg_embedding)

    all_sims = np.dot(all_embeddings_norm, embeddings_norm.T)
    max_sims = np.max(all_sims, axis=1)

    similarities = 0.7 * avg_sims + 0.3 * max_sims

    # Filter and sort
    matches = []
    seen_images = set()
    sorted_indices = np.argsort(similarities)[::-1]

    for idx in sorted_indices:
        score = float(similarities[idx])
        if score < threshold:
            break
        entry = index_data[idx]
        image_name = entry['image']
        if image_name in seen_images:
            continue
        seen_images.add(image_name)
        matches.append({
            'image': image_name,
            'score': round(score, 4),
            'bbox': entry['bbox'],
        })
        if len(matches) >= limit:
            break

    print(json.dumps(matches))


def main():
    parser = argparse.ArgumentParser(description='Face Search for News Images')
    parser.add_argument('--build-index', action='store_true', help='Build/update face index')
    parser.add_argument('--check-new', action='store_true', help='Check how many new images need indexing (fast, no model loading)')
    parser.add_argument('--search', type=str, metavar='IMAGE', help='Search for faces matching the image')
    parser.add_argument('--search-multi', type=str, nargs='+', metavar='IMAGES', help='Search using multiple images of the same person')
    parser.add_argument('--relation-search', type=str, nargs='+', metavar='IMAGES', help='Find people who frequently appear with the target person')
    parser.add_argument('--strategy', type=str, choices=['average', 'max', 'hybrid'], default='hybrid', help='Multi-image fusion strategy (default: hybrid)')
    parser.add_argument('--threshold', type=float, default=0.4, help='Similarity threshold (0-1)')
    parser.add_argument('--cluster-threshold', type=float, default=0.35, help='Cluster similarity threshold for relation search (0-1)')
    parser.add_argument('--limit', type=int, default=20, help='Max results to return')
    parser.add_argument('--save-name', type=str, metavar='NAME', help='Save a named face identity')
    parser.add_argument('--embeddings-from', type=str, nargs='+', metavar='IMAGES', help='Images to extract face embeddings from (used with --save-name)')
    parser.add_argument('--list-names', action='store_true', help='List all saved named faces')
    parser.add_argument('--delete-name', type=str, metavar='NAME', help='Delete a named face identity')
    parser.add_argument('--search-name', type=str, metavar='NAME', help='Search for a person by saved name')
    parser.add_argument('--pair-search-a', type=str, nargs='+', metavar='IMAGES', help='Images of person A for pair search')
    parser.add_argument('--pair-search-b', type=str, nargs='+', metavar='IMAGES', help='Images of person B for pair search')

    args = parser.parse_args()

    if args.build_index:
        build_index()
    elif args.check_new:
        check_new_images()
    elif args.pair_search_a and args.pair_search_b:
        pair_search(args.pair_search_a, args.pair_search_b, threshold=args.threshold)
    elif args.save_name:
        if not args.embeddings_from:
            print(json.dumps({'error': '--embeddings-from is required with --save-name'}))
            sys.exit(1)
        save_name(args.save_name, args.embeddings_from)
    elif args.list_names:
        list_names()
    elif args.delete_name:
        delete_name(args.delete_name)
    elif args.search_name:
        search_by_name(args.search_name, threshold=args.threshold, limit=args.limit)
    elif args.relation_search:
        relation_search(args.relation_search, threshold=args.threshold, strategy=args.strategy, cluster_threshold=args.cluster_threshold)
    elif args.search_multi:
        search_multi(args.search_multi, threshold=args.threshold, limit=args.limit, strategy=args.strategy)
    elif args.search:
        search(args.search, threshold=args.threshold, limit=args.limit)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
