# Dockerfile — Node.js + edge-tts (קול נוירוני, דורש רשת) עם נפילה חזרה ל-espeak-ng מקומי
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    espeak-ng \
    espeak-ng-data \
    python3 \
    python3-pip \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# edge-tts — עוטף את Microsoft Edge Neural TTS (חינמי, ללא מפתח API), קולות עברית:
# he-IL-AvriNeural (גברי), he-IL-HilaNeural (נשי)
RUN pip3 install --no-cache-dir --break-system-packages edge-tts

WORKDIR /app
COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2 ioredis
# cache-bust: edge-tts primary + espeak-ng fallback build v3
RUN espeak-ng --version && espeak-ng -v he 'בדיקה' -w /tmp/test.wav && echo 'espeak-ng Hebrew OK (fallback engine)'
RUN edge-tts --version && echo 'edge-tts installed OK'

EXPOSE 8080
CMD ["node", "server.js"]
