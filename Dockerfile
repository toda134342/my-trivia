# Dockerfile — Node.js + piper-tts via pip
# המודל העברי מוריד אוטומטית בעלייה הראשונה ונשמר ב-volume
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# התקנת piper-tts (pip package — כולל binary + ספריות ONNX)
RUN python3 -m venv /opt/piper-env \
    && /opt/piper-env/bin/pip install --no-cache-dir piper-tts

ENV PATH="/opt/piper-env/bin:$PATH"
ENV PIPER_VOICE_DIR="/app/data/piper-voices"

WORKDIR /app
COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8080
CMD ["node", "server.js"]
