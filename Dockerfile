# Dockerfile — Node.js + espeak-ng (קריין עברי מובנה, ללא הורדת מודל, ללא תלות ברשת)
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    espeak-ng \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .
COPY trivia.html .
COPY questions.json .

RUN npm init -y && npm install express yemot-router2
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8080
CMD ["node", "server.js"]
