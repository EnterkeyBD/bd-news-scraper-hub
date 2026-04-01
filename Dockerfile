FROM node:20

# System dependencies for Python, OpenCV, InsightFace, and ONNX Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Allow pip to install into system Python inside the container
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app

# ── Node.js dependencies ──────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Python dependencies ───────────────────────────────────────────────────────
# Install CPU-only PyTorch first (avoids pulling the full CUDA build)
RUN pip3 install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# ── Application code ──────────────────────────────────────────────────────────
COPY . .

# Ensure all runtime directories exist inside the image
RUN mkdir -p news_images logs uploaded_news_images uploads_temp last_run

# Pre-download InsightFace buffalo_l models so face search works out of the box
RUN mkdir -p /root/.insightface/models/buffalo_l && \
    curl -L -o /tmp/buffalo_l.zip \
        https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip && \
    unzip /tmp/buffalo_l.zip -d /root/.insightface/models/buffalo_l && \
    rm /tmp/buffalo_l.zip

EXPOSE 3000

CMD ["node", "server.js"]
