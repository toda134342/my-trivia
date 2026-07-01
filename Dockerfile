# Dockerfile — Node.js + Piper TTS (מנוע קול מקומי, ללא תלות ברשת בזמן ריצה)
FROM node:20-slim

# התקנת תלויות מערכת: Python + pip + espeak-ng (נדרש ל-Piper)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    espeak-ng \
    espeak-ng-data \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# התקנת piper-tts — מתקין binary ישיר ב-/usr/local/bin/piper
RUN pip3 install --break-system-packages --no-cache-dir piper-tts

WORKDIR /app
COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8080
CMD ["node", "server.js"]
