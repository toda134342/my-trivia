# פריסה ל-Render.com — הוראות מלאות

## הכנה חד-פעמית

1. **צור חשבון** ב-https://render.com (חינמי)

2. **העלה לGitHub** — הוסף את הקבצים הבאים לrepository:
   - `server.js`
   - `trivia.html`
   - `questions.json`
   - `Dockerfile`
   - `render.yaml`

## פריסה ב-Render

### שיטה א׳ — אוטומטית (מומלץ)
1. לך ל-Render Dashboard → **New** → **Blueprint**
2. חבר את ה-GitHub repository
3. Render יזהה את `render.yaml` ויפרוס אוטומטית

### שיטה ב׳ — ידנית
1. לך ל-Render Dashboard → **New** → **Web Service**
2. חבר GitHub repository
3. הגדרות:
   - **Environment**: Docker
   - **Dockerfile Path**: `./Dockerfile`
   - **Plan**: Free
4. תחת **Disks** → הוסף disk:
   - **Mount Path**: `/app/data`
   - **Size**: 1 GB
5. לחץ **Create Web Service**

## מה קורה בפריסה?

הDockerfile בונה קונטיינר אחד שמכיל:
- ✅ Node.js — שרת המשחק (port 8080)
- ✅ Python + edge-tts — קולות עבריים Neural מMicrosoft
- ✅ אין צורך בשירות Docker נפרד!

## כתובת המשחק

אחרי הפריסה תקבל כתובת בצורה:
`https://trivia-game.onrender.com`

> **שים לב**: בפלן החינמי, השרת "נרדם" אחרי 15 דקות של חוסר פעילות.
> הטעינה הראשונה יכולה לקחת ~30 שניות.

