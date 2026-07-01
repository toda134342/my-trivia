# Dockerfile — Node.js + espeak-ng עברית (מקומי לחלוטין, ללא רשת, ללא Python)
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    espeak-ng \
    espeak-ng-data \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2

EXPOSE 8080
CMD ["node", "server.js"]
