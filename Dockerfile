# Dockerfile — Node.js + Piper TTS (מקומי לחלוטין, ללא תלות באינטרנט)
FROM node:20-slim

# כלי בסיס + wget להורדת Piper
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ========== Piper TTS — התקנה מקומית ==========
# מזהה ארכיטקטורה אוטומטית (amd64 / arm64)
RUN set -e; \
    ARCH=$(dpkg --print-architecture); \
    if [ "$ARCH" = "amd64" ]; then PIPER_ARCH="x86_64"; else PIPER_ARCH="aarch64"; fi; \
    echo "Installing Piper for $PIPER_ARCH"; \
    wget -q "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_${PIPER_ARCH}.tar.gz" \
         -O /tmp/piper.tar.gz; \
    mkdir -p /opt/piper; \
    tar -xzf /tmp/piper.tar.gz -C /opt/piper; \
    mv /opt/piper/piper/piper /usr/local/bin/piper; \
    mv /opt/piper/piper/espeak-ng-data /usr/local/lib/espeak-ng-data; \
    rm -rf /tmp/piper.tar.gz /opt/piper; \
    chmod +x /usr/local/bin/piper

# ========== מודל עברית (Piper — he_IL) ==========
RUN mkdir -p /opt/piper-voices && \
    wget -q "https://huggingface.co/rhasspy/piper-voices/resolve/main/he/he_IL/local/high/he_IL-local-high.onnx" \
         -O /opt/piper-voices/he_IL.onnx && \
    wget -q "https://huggingface.co/rhasspy/piper-voices/resolve/main/he/he_IL/local/high/he_IL-local-high.onnx.json" \
         -O /opt/piper-voices/he_IL.onnx.json

WORKDIR /app

COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2

RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8080
CMD ["node", "server.js"]
