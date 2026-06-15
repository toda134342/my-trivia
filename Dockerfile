# Dockerfile יחיד ל-Render.com — Node.js + Python + edge-tts הכל ביחד
FROM node:20-slim

# התקנת Python ו-pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# התקנת edge-tts דרך Python (venv כדי לעקוף "externally managed environment")
RUN python3 -m venv /opt/edge-tts-env \
    && /opt/edge-tts-env/bin/pip install --no-cache-dir edge-tts

# הוספת edge-tts ל-PATH
ENV PATH="/opt/edge-tts-env/bin:$PATH"

# הגדרת תיקיית עבודה
WORKDIR /app

# העתקת קבצי הפרויקט
COPY server.js .
COPY trivia.html .
COPY questions.json .

# התקנת תלויות Node.js
RUN npm init -y && npm install express yemot-router2

# יצירת תיקיית data
RUN mkdir -p /app/data

VOLUME /app/data

EXPOSE 8080

CMD ["node", "server.js"]
