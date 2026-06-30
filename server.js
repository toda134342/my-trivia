const express = require('express');
const fs = require('fs');
const path = require('path');
const { YemotRouter } = require('yemot-router2');

const PORT = 8080;
const NAMES_FILE = '/app/data/names.json';
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// ===== GATEWAY — ROOMS & PASSWORDS =====
const MASTER_KEY = '345345'; // סיסמת על — גישה לכל חדר
const ROOMS_FILE = '/app/data/rooms.json';
const ROOMS_DIR  = '/app/data/rooms'; // תיקיית קבצי חדרים

function ensureRoomsDir() {
  if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

function roomFilePath(roomId) {
  // sanitize: שמות קבצים בטוחים בלבד
  const safe = roomId.replace(/[^a-zA-Z0-9א-ת\-_]/g, '_');
  return path.join(ROOMS_DIR, `${safe}.json`);
}

function loadRoomData(roomId) {
  try {
    const fp = roomFilePath(roomId);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {}
  return { roomId, questions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function saveRoomData(roomId, data) {
  ensureRoomsDir();
  try {
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(roomFilePath(roomId), JSON.stringify(data, null, 2));
    log('💾', `חדר "${roomId}" נשמר (${data.questions?.length || 0} שאלות)`);
  } catch(e) { log('⚠️', 'שגיאה בשמירת חדר: ' + e.message); }
}

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveRooms(rooms) {
  try {
    const dir = path.dirname(ROOMS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
  } catch(e) { log('⚠️', 'שגיאה בשמירת חדרים: ' + e.message); }
}

// ===== הגדרות גלובליות — קול, ערכת נושא, וכו' — מקור אמת יחיד לכל המחשבים =====
// כל שינוי שנשמר כאן זמין מיידית לכל מחשב/דפדפן שמתחבר לשרת, כי הוא נטען מכאן ולא מ-localStorage המקומי
const SETTINGS_FILE = '/app/data/settings.json';
let appSettings = {};

function loadAppSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      appSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return;
    }
  } catch (e) { log('⚠️', 'שגיאה בטעינת הגדרות: ' + e.message); }
  appSettings = {};
}

function saveAppSettings() {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  } catch (e) { log('⚠️', 'שגיאה בשמירת הגדרות: ' + e.message); }
}

loadAppSettings();

let players = {};
let playerNames = {};
let currentQuestion = 0;
let gameState = 'lobby'; // lobby | playing | scores
let gameMode = 'classic'; // classic | headtohead | vote
let questions = [];
let questionTimer = null;
let clients = [];
let firstCorrect = null; // headtohead mode - who answered first
let activeRoomId = null; // החדר הפעיל הנוכחי — אם null, משחק מהמאגר הכללי
let gamePaused = false;
let pausedTimeLeft = 0;
let pauseStartTime = 0;
let questionTimeLeft = 22;

// ===== מערכת לוגים מתועדת — זיכרון + קובץ קבוע ב-/app/data =====
const LOGS_DIR  = '/app/data/logs';
const LOG_FILE  = path.join(LOGS_DIR, 'app.log');
const LOG_RING_MAX = 2000;          // כמה שורות שומרים בזיכרון להצגה מהירה
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5MB — אחרי זה מתחילים קובץ חדש
let logRing = []; // {t, emoji, msg, src}

function ensureLogsDir() {
  try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
}

function rotateLogFileIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > LOG_FILE_MAX_BYTES) {
      const archived = path.join(LOGS_DIR, `app-${Date.now()}.log`);
      fs.renameSync(LOG_FILE, archived);
    }
  } catch {}
}

function appendLogToFile(line) {
  try {
    ensureLogsDir();
    rotateLogFileIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {} // לוגים לא אמורים להפיל את השרת
}

function log(emoji, msg, src) {
  const t = new Date();
  const timeStr = t.toISOString().slice(11, 23);
  const line = `[${timeStr}] ${emoji} ${msg}`;
  console.log(line);

  const entry = { t: t.toISOString(), emoji, msg, src: src || 'server' };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  appendLogToFile(`[${t.toISOString()}] [${entry.src}] ${emoji} ${msg}`);
}

// טעינת היסטוריית לוגים אחרונה מהקובץ הקבוע אל תוך הזיכרון בעת עליית השרת
function loadRecentLogsFromFile() {
  try {
    ensureLogsDir();
    if (!fs.existsSync(LOG_FILE)) return;
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-LOG_RING_MAX);
    logRing = lines.map(line => {
      const m = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(\S+)\s*(.*)$/);
      if (m) return { t: m[1], src: m[2], emoji: m[3], msg: m[4] };
      return { t: new Date().toISOString(), src: 'server', emoji: '📝', msg: line };
    });
  } catch {}
}
loadRecentLogsFromFile();

function loadNames() {
  try {
    if (fs.existsSync(NAMES_FILE)) playerNames = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
  } catch { playerNames = {}; }
}

function saveNames() {
  try {
    const dir = path.dirname(NAMES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NAMES_FILE, JSON.stringify(playerNames, null, 2));
  } catch (e) { log('⚠️', e.message); }
}

function loadQuestions() {
  try { return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); }
  catch { return []; }
}

// ===== QUESTION MEMORY — no repeats until all asked =====
const ASKED_FILE = '/app/data/asked_questions.json';
let askedQuestionIds = new Set();

function loadAskedQuestions() {
  try {
    if (fs.existsSync(ASKED_FILE)) {
      const data = JSON.parse(fs.readFileSync(ASKED_FILE, 'utf8'));
      // Reset if saved date is from a different day
      const today = new Date().toISOString().slice(0,10);
      if (data.date === today) {
        askedQuestionIds = new Set(data.ids || []);
        log('📝', `נטענו ${askedQuestionIds.size} שאלות שנשאלו היום`);
        return;
      }
    }
  } catch {}
  askedQuestionIds = new Set();
}

function saveAskedQuestions() {
  try {
    const dir = '/app/data';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0,10);
    fs.writeFileSync(ASKED_FILE, JSON.stringify({ date: today, ids: [...askedQuestionIds] }));
  } catch(e) { log('⚠️', 'שגיאה בשמירת שאלות: ' + e.message); }
}

function markQuestionsAsked(qs) {
  qs.forEach(q => askedQuestionIds.add(q.q)); // use question text as ID
  saveAskedQuestions();
}

function getUnaskedQuestions(pool) {
  const unasked = pool.filter(q => !askedQuestionIds.has(q.q));
  // If all questions have been asked, reset memory and use all
  if (unasked.length === 0) {
    log('🔄', 'כל השאלות נשאלו — מאפס זיכרון');
    askedQuestionIds = new Set();
    saveAskedQuestions();
    return [...pool];
  }
  return unasked;
}

loadAskedQuestions();



function getPlayerName(phone) {
  // אם יש חדר פעיל — בדוק קודם באנשי קשר של החדר
  if (activeRoomId) {
    const roomData = loadRoomData(activeRoomId);
    if (roomData.contacts && roomData.contacts[phone]) return roomData.contacts[phone];
  }
  return playerNames[phone] || ('שחקן ' + phone.slice(-4));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.write(msg); return true; } catch { return false; } });
}

// ===== GAME LOGIC =====
function handleAnswer(player, chosen) {
  if (!questions[currentQuestion]) return;
  const q = questions[currentQuestion];
  if (player.answered) return;
  if (chosen < 0 || chosen > 3) return;

  player.answered = true;
  player._chosen = chosen;
  const isCorrect = chosen === q.correct;

  // בדוק אם כולם ענו — אם כן, קצר את הזמן ל-3 שניות
  const checkAllAnswered = () => {
    const active = Object.values(players).filter(p => !p._eliminated);
    const allAnswered = active.every(p => p.answered);
    if (allAnswered && questionTimer) {
      clearTimeout(questionTimer);
      questionTimer = setTimeout(revealAnswer, 3000);
      broadcast({ type: 'allAnswered' });
      log('✅', 'כולם ענו — חשיפה בעוד 3 שניות');
    }
  };

  if (gameMode === 'vote') {
    broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, mode: 'vote' });
    log('🗳️', `${player.name} הצביע ${chosen + 1}`);
    checkAllAnswered(); return;
  }

  if (gameMode === 'headtohead') {
    if (isCorrect && !firstCorrect) {
      firstCorrect = player.callId;
      player.score += 100; player.correct++;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, first: true, mode: 'headtohead' });
      log('⚡', `${player.name} ראשון! +100`);
    } else {
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, first: false, mode: 'headtohead' });
    }
    checkAllAnswered(); return;
  }

  if (gameMode === 'survival') {
    // הישרדות — שגוי = יצא מהמשחק
    if (isCorrect) {
      player.score += 100; player.correct++;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, mode: 'survival' });
      log('💀', `${player.name} שרד!`);
    } else {
      player._eliminated = true;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, eliminated: true, mode: 'survival' });
      broadcast({ type: 'playerEliminated', playerName: player.name, callId: player.callId });
      log('💀', `${player.name} יצא!`);
      // בדוק אם נשאר רק שחקן אחד
      const alive = Object.values(players).filter(p => !p._eliminated);
      if (alive.length <= 1 && Object.keys(players).length > 1) {
        clearTimeout(questionTimer);
        setTimeout(revealAnswer, 1500);
        return;
      }
    }
    checkAllAnswered(); return;
  }

  if (gameMode === 'blitz') {
    // בליץ — 5 שניות, רצף נכון = בונוס
    if (isCorrect) {
      player._streak = (player._streak || 0) + 1;
      const bonus = Math.min(player._streak * 10, 50); // עד 50 בונוס
      const pts = 50 + bonus;
      player.score += pts; player.correct++;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, pts, streak: player._streak, mode: 'blitz' });
      log('⚡', `${player.name} בליץ! רצף ${player._streak} +${pts}`);
    } else {
      player._streak = 0;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, pts: 0, streak: 0, mode: 'blitz' });
    }
    checkAllAnswered(); return;
  }


  if (gameMode === 'speedrun') {
    // ספידראן — 10 שניות, ניקוד לפי מהירות
    if (isCorrect) {
      const timeLeft = questionTimeLeft || 10;
      const pts = Math.round(40 + (timeLeft / 10) * 60); // 40-100 נק'
      player.score += pts; player.correct++;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, pts, mode: 'speedrun' });
      log('🏃', `${player.name} נכון! +${pts}`);
    } else {
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, pts: 0, mode: 'speedrun' });
    }
    checkAllAnswered(); return;
  }

  if (gameMode === 'teamplay') {
    // קבוצות — 1,2 נגד 3,4 (לפי מיקום בחיוג)
    const playerList = Object.values(players);
    const pIdx = playerList.findIndex(p => p.callId === player.callId);
    const team = pIdx % 2 === 0 ? 1 : 2; // זוגי=קבוצה1, אי-זוגי=קבוצה2
    player._team = team;
    if (isCorrect) {
      player.score += 100; player.correct++;
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, team, mode: 'teamplay' });
    } else {
      broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, team, mode: 'teamplay' });
    }
    checkAllAnswered(); return;
  }

  // classic — מהיר יותר = יותר ניקוד
  if (isCorrect) {
    const prevCorrect = Object.values(players).filter(p => p !== player && p._chosen === q.correct && p.answered).length;
    const pts = Math.max(60, 100 - prevCorrect * 20);
    player.score += pts; player.correct++;
    broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, pts, mode: 'classic' });
    log('🎯', `${player.name} → נכון! +${pts}`);
  } else {
    broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, pts: 0, mode: 'classic' });
  }
  checkAllAnswered();
}

let questionCount = 10; // configurable number of questions per game

function startGame(topic = 'all', mode = 'classic', topics = null, roomId = null) {
  gameMode = mode;

  // אם יש חדר פעיל עם שאלות — השתמש בהן במקום המאגר הכללי
  if (roomId) {
    const roomData = loadRoomData(roomId);
    if (roomData.questions && roomData.questions.length > 0) {
      activeRoomId = roomId;
      // סנן לפי קטגוריות פעילות
      let poolQuestions = roomData.questions;
      if (Array.isArray(roomData.activeCategories)) {
        if (roomData.activeCategories.length === 0) {
          log('⚠️', 'אין קטגוריות פעילות בחדר — לא מתחיל');
          return false;
        }
        const activeCatSet = new Set(roomData.activeCategories);
        const filtered = poolQuestions.filter(q => !q.topic || activeCatSet.has(q.topic));
        if (filtered.length > 0) poolQuestions = filtered;
      }
      log('🏠', `משחק מחדר "${roomId}" — ${poolQuestions.length} שאלות (מתוך ${roomData.questions.length})`);
      const maxQ = mode === 'speedrun' ? 15 : mode === 'blitz' ? 15 : questionCount;
      const unasked = getUnaskedQuestions(poolQuestions);
      questions = shuffle(unasked.length > 0 ? unasked : poolQuestions).slice(0, Math.min(maxQ, poolQuestions.length));
      markQuestionsAsked(questions);
      currentQuestion = 0;
      gameState = 'playing';
      firstCorrect = null;
      Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; p._eliminated = false; p._team = null; p._streak = 0; });
      broadcast({ type: 'gameStart', total: questions.length, topic: roomId, mode, fromRoom: true, roomId });
      showQuestion();
      return true;
    }
    log('⚠️', `חדר "${roomId}" קיים אך אין בו שאלות — נופל למאגר כללי`);
  }

  activeRoomId = null;
  const allQ = loadQuestions();
  // Convert family questions to same format as regular questions
  const familyQ = loadFamilyQuestions().map(q => ({ ...q, topic: q.setName || q.setId }));
  const combined = [...allQ, ...familyQ];

  let filtered;
  if (topics && topics.length > 0) {
    filtered = combined.filter(q => topics.includes(q.topic));
  } else {
    filtered = topic === 'all' ? allQ : combined.filter(q => q.topic === topic);
  }
  if (filtered.length === 0) return false;
  const maxQ = mode === 'speedrun' ? 15 : mode === 'blitz' ? 15 : questionCount;
  const unasked = getUnaskedQuestions(filtered);
  questions = shuffle(unasked).slice(0, Math.min(maxQ, unasked.length));
  markQuestionsAsked(questions);
  currentQuestion = 0;
  gameState = 'playing';
  firstCorrect = null;
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; p._eliminated = false; p._team = null; p._streak = 0; });
  log('🎮', `משחק התחיל — מצב: ${mode} | נושא: ${topic}`);
  broadcast({ type: 'gameStart', total: questions.length, topic, mode });
  showQuestion();
  return true;
}

function showQuestion() {
  if (currentQuestion >= questions.length) { endGame(); return; }
  // בהישרדות — בדוק אם נשאר רק שחקן אחד
  if (gameMode === 'survival') {
    const alive = Object.values(players).filter(p => !p._eliminated);
    if (alive.length <= 1 && Object.keys(players).length > 1) { endGame(); return; }
  }
  const q = questions[currentQuestion];
  firstCorrect = null;
  const timeLimit = gameMode === 'speedrun' ? 10 : gameMode === 'blitz' ? 5 : 22;
  questionTimeLeft = timeLimit;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  log('❓', `שאלה ${currentQuestion + 1}: ${q.q}`);
  broadcast({ type: 'question', index: currentQuestion, total: questions.length, question: q.q, answers: q.a, topic: q.topic, mode: gameMode, timeLimit });
  clearTimeout(questionTimer);
  questionTimer = setTimeout(revealAnswer, timeLimit * 1000);
  // עדכן questionTimeLeft כל שנייה
  let tl = timeLimit;
  const tlInterval = setInterval(() => { tl--; questionTimeLeft = tl; if(tl<=0) clearInterval(tlInterval); }, 1000);
}

function revealAnswer() {
  clearTimeout(questionTimer);
  const q = questions[currentQuestion];
  log('💡', `תשובה: ${q.a[q.correct]}`);
  broadcast({
    type: 'reveal',
    correct: gameMode === 'vote' ? -1 : q.correct,
    correctText: q.a[q.correct],
    mode: gameMode,
    players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct }))
  });
  setTimeout(() => { currentQuestion++; showQuestion(); }, 4000);
}

function endGame() {
  gameState = 'scores';
  const sorted = Object.values(players).sort((a, b) => b.score - a.score);
  broadcast({ type: 'scores', players: sorted, mode: gameMode });
}

function resetGame() {
  stopAllTimers();
  gameState = 'lobby';
  gameMode = 'classic';
  currentQuestion = 0;
  questions = [];
  firstCorrect = null;
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'reset', players: Object.values(players) });
}

// ===== EXPRESS =====
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// ===== YEMOT =====
const yemotRouter = YemotRouter({ printLog: true });
yemotRouter.get('/yemot', async (call) => {
  const phone = call.phone;
  const callId = call.callId;
  if (!players[callId]) {
    // מחק שחקן ישן עם אותו מספר טלפון (חיוג מחדש)
    const oldEntry = Object.values(players).find(p => p.phone === phone && p.callId !== callId);
    if (oldEntry) {
      log('🔄', `חיוג מחדש: ${phone} — מחק callId ישן`);
      broadcast({ type: 'playerLeave', callId: oldEntry.callId });
      delete players[oldEntry.callId];
    }
    const name = getPlayerName(phone);
    const colorIdx = Object.keys(players).length % 6;
    players[callId] = { callId, phone, name, score: 0, correct: 0, answered: false, color: colorIdx, _chosen: null };
    broadcast({ type: 'playerJoin', player: players[callId] });
    // שמור במאגר הגלובלי רק אם השם לא בא מאנשי קשר של חדר
    const inRoomContacts = activeRoomId && loadRoomData(activeRoomId)?.contacts?.[phone];
    if (!inRoomContacts && !playerNames[phone]) { playerNames[phone] = name; saveNames(); }
    log('✅', `נכנס: ${name}`);
  }
await call.read(
    [{ type: 'text', data: 'ברוך הבא למשחק הטריוויה ראש בראש' }], 'tap',
    { max_digits: 1, digits_allowed: [1,2,3,4], sec_wait: 5, allow_empty: true }
  );
  try {
    while (true) {
      const player = players[callId];
      if (!player) break;
            const digit = await call.read(
        [{ type: 'text', data: ' ' }], 'tap',
        { max_digits: 1, digits_allowed: [1,2,3,4], sec_wait: 60, allow_empty: true }
      );
      if (gameState === 'playing' && digit && ['1','2','3','4'].includes(String(digit))) {
        const chosen = parseInt(digit) - 1;
        if (gameMode === 'reaction') handleReactionAnswer(player, parseInt(digit));
        else if (gameMode === 'number') handleNumberGuess(player, parseInt(digit));
        else if (gameMode === 'wordchain') handleWCAnswer(player, parseInt(digit));
        else if (gameMode === 'majority') handleMajorityAnswer(player, parseInt(digit)-1);
        else if (gameMode === 'whosaid')   handleWhoAnswer(player, chosen);
        else if (gameMode === 'lightning') handleLightningAnswer(player, chosen);
        else if (gameMode === 'truefalse') handleTFAns(player, chosen);
        else if (gameMode === 'price')     handlePriceAns(player, chosen);
        else if (gameMode === 'emoji')     handleEmojiAns(player, chosen);
        else if (gameMode === 'hotseat')   handleHotseatAns(player, chosen);
        else if (gameMode === 'family')    handleFamilyAnswer(player, chosen);
        else if (gameMode === 'guesssong') handleGuessSongAnswer(player, chosen);
        else if (gameMode === 'whoami')    handleWhoAmIAnswer(player, chosen);
        else if (gameMode === 'biblechain') handleBCAnswer(player, chosen);
        else if (gameMode === 'whofirst')  handleWFAnswer(player, chosen);
        else if (gameMode === 'spinwheel') handleSWAnswer(player, chosen);
        else if (gameMode === 'doubledown') handleDDAnswer(player, parseInt(digit));
        else if (gameMode === 'flashback') handleFBAnswer(player, chosen);
        else if (gameMode === 'picture')   handlePicAnswer(player, chosen);
        else if (gameMode === 'pyramid')   handlePyramidAnswer(player, chosen);
        else if (gameMode === 'passnote')  handlePassNoteAnswer(player, chosen);
        else handleAnswer(player, chosen);
      }
    }
  } catch (e) {
    log('📵', `ניתוק: ${players[callId]?.name || phone} — ${e.message}`);
  } finally {
    if (players[callId]) {
      const name = players[callId].name;
      broadcast({ type: 'playerLeave', callId });
      delete players[callId];
      log('👋', `יצא: ${name}`);
    }
  }
});
app.use(yemotRouter);

// ===== ROUTES =====
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const regularTopics = [...new Set(loadQuestions().map(q => q.topic))];
  const familyTopics = loadFamilySets().map(s => s.name || s.id);
  const allTopics = [...regularTopics, ...familyTopics];
  // Build current question state for reconnecting clients
  let currentRoundData = null;
  if (gameState === 'playing') {
    if (gameMode === 'pyramid' && pyramidRound > 0 && pyramidQuestions[pyramidRound-1]) {
      const q = pyramidQuestions[pyramidRound-1];
      currentRoundData = {
        type: 'pyramidRound', round: pyramidRound, total: pyramidQuestions.length,
        question: q.q, answers: q.a, topic: q.topic,
        pts: PYRAMID_PTS[pyramidRound-1], label: PYRAMID_LABELS[pyramidRound-1],
        timeLimit: PYRAMID_TIME[pyramidRound-1], mode: 'pyramid',
        playerScores: Object.values(players).map(p => ({ callId: p.callId, score: p.score, eliminated: p._eliminated }))
      };
    } else if (gameMode === 'passnote' && passRound > 0 && passQuestions[passRound-1]) {
      const q = passQuestions[passRound-1];
      currentRoundData = { type: 'question', question: q.q, answers: q.a, index: passRound, total: passQuestions.length, timeLimit: 8, mode: 'passnote' };
    }
  }
  res.write(`data: ${JSON.stringify({ type: 'init', players: Object.values(players), gameState, currentQuestion, playerNames, gameMode, topics: allTopics, familySets: loadFamilySets(), currentRoundData, activeRoomId })}\n\n`);
  clients.push(res);
  req.on('close', () => { clients = clients.filter(c => c !== res); });
});

app.get('/start', (req, res) => {
  const topic = req.query.topic || 'all';
  const mode = req.query.mode || 'classic';
  const roomId = req.query.roomId || null;
  if (mode === 'reaction') { startReactionGame(); return res.send('started'); }
  if (mode === 'number')   { startNumberGame();   return res.send('started'); }
  if (mode === 'wordchain'){ startWordChain();    return res.send('started'); }
  if (mode === 'whosaid')  { startWhoSaid();     return res.send('started'); }
  if (mode === 'lightning'){ startLightning();   return res.send('started'); }
  if (mode === 'majority') { startMajority();     return res.send('started'); }
  if (mode === 'price')    { startPrice();        return res.send('started'); }
  if (mode === 'truefalse'){ startTrueFalse();    return res.send('started'); }
  if (mode === 'emoji')    { startEmoji();        return res.send('started'); }
  if (mode === 'hotseat')  { startHotseat();      return res.send('started'); }
  if (mode === 'guesssong'){ startGuessSong();    return res.send('started'); }
  if (mode === 'whoami')   { startWhoAmI();       return res.send('started'); }
  if (mode === 'biblechain'){ startBibleChain();  return res.send('started'); }
  if (mode === 'family')   {
    const setId = req.query.topic || 'all';
    const ok = startFamily(setId);
    return res.writeHead(ok ? 200 : 400).end(ok ? 'started' : 'no family questions');
  }
  const topicsParam = req.query.topics ? req.query.topics.split(',').map(t => t.trim()).filter(Boolean) : null;
  const ok = startGame(topic, mode, topicsParam, roomId);
  res.writeHead(ok ? 200 : 400); res.end(ok ? 'started' : 'no questions');
});

app.get('/reset', (req, res) => { resetGame(); res.send('reset'); });

// מצב החדר הפעיל — מחזיר איזה חדר רץ כרגע (אם בכלל)
app.get('/room-status', (req, res) => {
  res.json({
    activeRoomId,
    gameState,
    fromRoom: !!activeRoomId,
    questionCount: questions.length
  });
});
function stopAllTimers() {
  clearTimeout(questionTimer);
  clearTimeout(reactionTimer);
  clearTimeout(wcTimer);
  clearTimeout(majTimer2);
  clearTimeout(whoTimer);
  clearTimeout(lightTimer);
  clearTimeout(priceTimer);
  clearTimeout(tfTimer);
  clearTimeout(emojiTimer);
  clearTimeout(hotTimer);
  if (typeof numTimer !== 'undefined') clearTimeout(numTimer);
  if (typeof familyTimer !== 'undefined') clearTimeout(familyTimer);
  if (typeof guessSongTimer !== 'undefined') clearTimeout(guessSongTimer);
  if (typeof whoAmITimer !== 'undefined') clearTimeout(whoAmITimer);
  if (typeof bcTimer !== 'undefined') clearTimeout(bcTimer);
  if (typeof wfTimer !== 'undefined') clearTimeout(wfTimer);
  if (typeof swTimer !== 'undefined') clearTimeout(swTimer);
  if (typeof ddTimer !== 'undefined') clearTimeout(ddTimer);
  if (typeof fbTimer !== 'undefined') clearTimeout(fbTimer);
  if (typeof passTimer !== 'undefined') clearTimeout(passTimer);
  if (typeof pyramidTimer !== 'undefined') clearTimeout(pyramidTimer);
  if (typeof picTimer !== 'undefined') clearTimeout(picTimer);
  gamePaused = false;
}

app.get('/stop', (req, res) => {
  stopAllTimers();
  gameState = 'lobby';
  broadcast({ type: 'stopped' });
  res.send('stopped');
});

// ===== PAUSE / NEXT / REVEAL =====

app.get('/pause', (req, res) => {
  if (gameState !== 'playing') { res.send('not playing'); return; }
  if (!gamePaused) {
    // PAUSE — freeze timer
    gamePaused = true;
    pauseStartTime = Date.now();
    // Calculate how many ms remain in the current question
    const q = questions[currentQuestion];
    if (q && questionTimer) {
      clearTimeout(questionTimer);
      pausedTimeLeft = Math.max(0, questionTimeLeft * 1000);
    }
    broadcast({ type: 'paused' });
    log('⏸️', 'משחק מושהה');
    res.send('paused');
  } else {
    // RESUME
    gamePaused = false;
    if (pausedTimeLeft > 0) {
      questionTimer = setTimeout(revealAnswer, pausedTimeLeft);
    }
    broadcast({ type: 'resumed', secondsLeft: Math.round(pausedTimeLeft / 1000) });
    log('▶️', 'משחק ממשיך');
    res.send('resumed');
  }
});

app.get('/next', (req, res) => {
  if (gameState !== 'playing') { res.send('not playing'); return; }
  gamePaused = false;
  clearTimeout(questionTimer);
  currentQuestion++;
  showQuestion();
  log('⏭️', 'דילג לשאלה הבאה');
  res.send('next');
});

app.get('/reveal', (req, res) => {
  if (gameState !== 'playing') { res.send('not playing'); return; }
  gamePaused = false;
  clearTimeout(questionTimer);
  revealAnswer();
  log('👁️', 'חשף תשובה ידנית');
  res.send('revealed');
});
app.get('/kick', (req, res) => {
  const callId = req.query.callId;
  if (callId && players[callId]) { broadcast({ type: 'playerLeave', callId }); delete players[callId]; }
  res.send('kicked');
});

app.post('/setname', (req, res) => {
  const { phone, name } = req.body;
  if (phone && name) {
    playerNames[phone] = name;
    saveNames();
    Object.values(players).forEach(p => { if (p.phone === phone) { p.name = name; broadcast({ type: 'playerUpdate', callId: p.callId, name }); } });
  }
  res.json({ ok: true });
});

app.get('/all-names', (req, res) => {
  res.json(playerNames);
});

// Bulk import names (from localStorage sync on page load)
app.post('/import-names', (req, res) => {
  const names = req.body;
  if (typeof names !== 'object' || Array.isArray(names)) { res.status(400).json({ok:false}); return; }
  let added = 0;
  Object.entries(names).forEach(([phone, name]) => {
    if (phone && name && typeof phone === 'string' && typeof name === 'string') {
      if (!playerNames[phone]) { playerNames[phone] = name; added++; }
    }
  });
  if (added > 0) saveNames();
  res.json({ ok: true, added, total: Object.keys(playerNames).length });
});

app.delete('/names/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  if (playerNames[phone]) {
    delete playerNames[phone];
    saveNames();
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: 'not found' });
  }
});

app.post('/add-question', (req, res) => {
  const { q, a, correct, topic, key } = req.body;
  if (key !== MASTER_KEY) return res.status(403).json({ ok: false, error: 'גישה אסורה' });
  if (!q || !a || a.length !== 4 || correct === undefined || !topic) { res.status(400).json({ ok: false }); return; }
  const qs = loadQuestions();
  qs.push({ q, a, correct, topic });
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(qs, null, 2));
  res.json({ ok: true, total: qs.length });
});

app.get('/questions', (req, res) => res.json(loadQuestions()));

app.get('/memory-status', (req, res) => {
  const allQ = loadQuestions();
  const askedList = [...askedQuestionIds];
  res.json({ total: allQ.length, asked: askedList.length, remaining: allQ.length - askedList.length, askedIds: askedList, questionCount });
});

app.post('/memory-reset', (req, res) => {
  const body = req.body || {};
  if (body.keepAsked && Array.isArray(body.keepAsked)) {
    askedQuestionIds = new Set(body.keepAsked);
  } else {
    askedQuestionIds = new Set();
  }
  saveAskedQuestions();
  res.json({ ok: true, asked: askedQuestionIds.size });
});

app.post('/set-question-count', (req, res) => {
  const n = parseInt((req.body || {}).count);
  if (isNaN(n) || n < 1 || n > 50) { res.status(400).json({ ok: false }); return; }
  questionCount = n;
  res.json({ ok: true, questionCount });
});

app.put('/questions/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  const { q, a, correct, topic, key } = req.body;
  // רק מנהל יכול לשנות שאלות במאגר המקורי
  if (key !== MASTER_KEY) return res.status(403).json({ ok: false, error: 'גישה אסורה — נדרשת סיסמת מנהל' });
  const qs = loadQuestions();
  if (idx < 0 || idx >= qs.length) { res.status(404).json({ ok: false }); return; }
  qs[idx] = { q, a, correct, topic };
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(qs, null, 2));
  log('✏️', `שאלה ${idx} עודכנה ע"י מנהל`);
  res.json({ ok: true });
});

app.delete('/questions/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  const { key } = req.body || {};
  // רק מנהל יכול למחוק מהמאגר המקורי
  if (key !== MASTER_KEY) return res.status(403).json({ ok: false, error: 'גישה אסורה — נדרשת סיסמת מנהל' });
  const qs = loadQuestions();
  if (idx < 0 || idx >= qs.length) { res.status(404).json({ ok: false }); return; }
  qs.splice(idx, 1);
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(qs, null, 2));
  log('🗑️', `שאלה ${idx} נמחקה ע"י מנהל`);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  const file = path.join(__dirname, 'trivia.html');
  if (fs.existsSync(file)) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(fs.readFileSync(file)); }
  else res.status(404).send('not found');
});

// ========== Piper TTS — מנוע קול מקומי ==========
// piper-tts pip package. מודל עברי מוריד אוטומטית בעלייה ראשונה, נשמר ב-volume.

const { execFile, spawn } = require('child_process');
const os = require('os');

const PIPER_BIN  = '/opt/piper-env/bin/piper';
const VOICE_DIR  = process.env.PIPER_VOICE_DIR || '/app/data/piper-voices';
const VOICE_NAME = 'he_IL-local-high';
let   PIPER_MODEL = path.join(VOICE_DIR, VOICE_NAME + '.onnx');

// הורדת המודל בעלייה (אם עוד לא קיים) — wget ישירות מ-HuggingFace
const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/he/he_IL/local/high';
async function ensurePiperVoice() {
  const onnxPath = path.join(VOICE_DIR, VOICE_NAME + '.onnx');
  const jsonPath = path.join(VOICE_DIR, VOICE_NAME + '.onnx.json');
  if (fs.existsSync(onnxPath) && fs.existsSync(jsonPath)) {
    log('✅', `Piper: מודל קיים: ${onnxPath}`);
    PIPER_MODEL = onnxPath;
    return;
  }
  fs.mkdirSync(VOICE_DIR, { recursive: true });

  const download = (url, dest) => new Promise((resolve, reject) => {
    log('⬇️', `Piper: מוריד ${url.split('/').pop()}...`);
    const https = require('https');
    const file  = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} עבור ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    });
    req.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

  try {
    await download(`${HF_BASE}/${VOICE_NAME}.onnx`, onnxPath);
    await download(`${HF_BASE}/${VOICE_NAME}.onnx.json`, jsonPath);
    log('✅', `Piper: מודל הורד → ${onnxPath}`);
    PIPER_MODEL = onnxPath;
  } catch (e) {
    log('🔇', `Piper: הורדת מודל נכשלה — ${e.message}`);
  }
}

// ===== פרופילי קולות גבריים =====
// Piper עצמו מייצר קול אחד, אנחנו נותנים "אישיות" שונה דרך עיבוד Sox (rate/pitch/reverb).
// כל הקולות גבריים ותוססים כפי שביקשת.
const EDGE_VOICES = {
  // --- גבריים ---
  'edge:avri':        { label: '👨 אברי — קריין רגיל',       rate: 1.0,  pitch: 0   },
  'edge:avri-deep':   { label: '🎤 ד"ר — קריין עמוק ונמוך',  rate: 0.92, pitch: -3  },
  'edge:avri-fast':   { label: '⚡ ספרינטר — קריין מהיר',    rate: 1.25, pitch: 1   },
  'edge:avri-warm':   { label: '🎙️ חבר — קריין חם ונעים',    rate: 0.97, pitch: -1  },
  // --- נשיים (נשמרים לתאימות לאחור אם מישהו בחר אותם בעבר) ---
  'edge:hila':           { label: '👩 הילה — קריינית רגילה',   rate: 1.0,  pitch: 3   },
  'edge:hila-warm':      { label: '🎙️ הילה — קריינית חמה',    rate: 0.95, pitch: 2   },
  'edge:hila-energetic': { label: '⚡ הילה — קריינית אנרגטית', rate: 1.2,  pitch: 4   },
};

// Cache in-memory — מונע עיכוב בטקסטים חוזרים
const _ttsCache = new Map();
const TTS_CACHE_MAX = 200;

// ===== הגבלת מקביליות — Piper מאוד יעיל אבל נגביל ל-2 תהליכים מקבילים כדי לא להעמיס את ה-CPU =====
// תור פשוט שמריץ לכל היותר MAX_CONCURRENT_TTS תהליכי Piper במקביל; השאר ממתינים בתור
const MAX_CONCURRENT_TTS = 2;
let _ttsActiveCount = 0;
const _ttsWaitQueue = [];

function _ttsRunQueued(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      _ttsActiveCount++;
      fn().then(
        (res) => { _ttsActiveCount--; _ttsDrainQueue(); resolve(res); },
        (err) => { _ttsActiveCount--; _ttsDrainQueue(); reject(err); }
      );
    };
    if (_ttsActiveCount < MAX_CONCURRENT_TTS) task();
    else _ttsWaitQueue.push(task);
  });
}

function _ttsDrainQueue() {
  while (_ttsActiveCount < MAX_CONCURRENT_TTS && _ttsWaitQueue.length) {
    const next = _ttsWaitQueue.shift();
    next();
  }
}

function fetchTTSOnce(text, voiceKey, speed) {
  return _ttsRunQueued(() => _fetchTTSOnceRaw(text, voiceKey, speed));
}

function _fetchTTSOnceRaw(text, voiceKey, speed) {
  return new Promise((resolve, reject) => {
    const profile = EDGE_VOICES[voiceKey] || EDGE_VOICES['edge:avri'];
    const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

    // Piper מקבל טקסט מ-stdin ומייצר WAV לקובץ
    const finalRate = (profile.rate || 1.0) * (speed || 1.0);
    const piperArgs = [
      '--model', PIPER_MODEL,
      '--output_file', tmpFile,
      '--length_scale', String(Math.round((1.0 / finalRate) * 100) / 100),  // length_scale הפוך מ-rate
    ];

    const proc = spawn(PIPER_BIN, piperArgs, { timeout: 15000 });

    let errBuf = '';
    proc.stderr.on('data', d => { errBuf += d.toString(); });

    proc.stdin.write(text);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code !== 0) {
        fs.unlink(tmpFile, () => {});
        return reject(new Error(`Piper נכשל (קוד ${code}): ${errBuf.trim().slice(0, 200)}`));
      }
      fs.readFile(tmpFile, (readErr, data) => {
        fs.unlink(tmpFile, () => {});
        if (readErr) return reject(readErr);
        if (!data || data.length === 0) return reject(new Error('Piper החזיר קובץ ריק'));
        resolve(data);
      });
    });

    proc.on('error', (err) => {
      fs.unlink(tmpFile, () => {});
      reject(new Error(`Piper שגיאת תהליך: ${err.message}`));
    });
  });
}

// קריאה לשרת ה-TTS הפנימי, עם ניסיון חוזר אוטומטי אם הניסיון הראשון נכשל
// (לרוב נכשל בגלל timeout רגעי מול שרתי מיקרוסופט — לא צריך ליפול לדפדפן, פשוט לנסות שוב)
let _lastTtsErrSignature = null;
let _lastTtsErrTime = 0;
let _ttsErrSuppressedCount = 0;
function logTtsError(emoji, fullMsg) {
  // חתימה ללא מספר ניסיון/טקסט ספציפי — רק הקול והשגיאה עצמה, כדי לזהות כשלים זהים חוזרים
  const sig = fullMsg.replace(/ניסיון \d\/3/, 'ניסיון X').replace(/"[^"]*"/, '"..."').slice(0, 150);
  const now = Date.now();
  if (sig === _lastTtsErrSignature && (now - _lastTtsErrTime) < 10000) {
    _ttsErrSuppressedCount++;
    return;
  }
  if (_ttsErrSuppressedCount > 0) {
    log('🔁', `(הושתקו ${_ttsErrSuppressedCount} שגיאות TTS זהות נוספות)`);
  }
  _ttsErrSuppressedCount = 0;
  _lastTtsErrSignature = sig;
  _lastTtsErrTime = now;
  log(emoji, fullMsg);
}

async function fetchTTS(text, voiceKey, speed = 1.0) {
  const cacheKey = voiceKey + '|' + speed + '|' + text;
  if (_ttsCache.has(cacheKey)) return _ttsCache.get(cacheKey);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchTTSOnce(text, voiceKey, speed);
      if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);
      _ttsCache.set(cacheKey, data);
      return data;
    } catch (err) {
      lastErr = err;
      logTtsError('⚠️', `Piper TTS ניסיון ${attempt}/3 נכשל [${voiceKey}] "${text.slice(0,30)}": ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

app.get('/tts', async (req, res) => {
  const text  = (req.query.text || '').slice(0, 500).trim();
  const key   = req.query.voice || 'edge:avri';
  const speed = Math.min(2.0, Math.max(0.5, parseFloat(req.query.speed) || 1.0));
  if (!text) return res.status(400).send('missing text');
  try {
    const buffer = await fetchTTS(text, key, speed);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buffer);
  } catch (err) {
    logTtsError('🛑', `Piper TTS נכשל סופית [${key}] "${text.slice(0,30)}": ${err.message}`);
    res.status(503).json({ error: 'שירות הקריינות לא זמין כרגע, נסה שוב' });
  }
});

// preload — מכין את האודיו לcache מראש, מחזיר 200 מיד
app.post('/tts-preload', async (req, res) => {
  const { text, voice, speed } = req.body || {};
  if (!text) return res.status(400).send('missing text');
  res.status(202).send('ok');
  const spd = Math.min(2.0, Math.max(0.5, parseFloat(speed) || 1.0));
  try { await fetchTTS(text.slice(0,500), voice||'edge:avri', spd); } catch {}
});

app.get('/tts-voices', (req, res) => {
  res.json(Object.entries(EDGE_VOICES).map(([id, v]) => ({ id, label: v.label })));
});

// ===== הגדרות גלובליות (קול, ערכת נושא, וכו') — אותו מקור לכל המחשבים =====
app.get('/settings', (req, res) => {
  res.json(appSettings);
});

app.post('/settings', (req, res) => {
  const body = req.body || {};
  let changed = false;
  Object.keys(body).forEach(k => {
    if (appSettings[k] !== body[k]) { appSettings[k] = body[k]; changed = true; }
  });
  if (changed) {
    saveAppSettings();
    // דחיפה מיידית לכל המחשבים המחוברים — לא מחכים לרענון דף
    broadcast({ type: 'settings-changed', settings: body });
    log('⚙️', `הגדרות עודכנו: ${Object.keys(body).join(', ')}`);
  }
  res.json({ ok: true, settings: appSettings });
});

// ===== מערכת לוגים — צפייה ושליחה =====

// קבלת לוגים מהלקוח (דפדפן) — מאחד הכל למקום אחד
app.post('/client-log', (req, res) => {
  try {
    const { emoji, msg, room, player } = req.body || {};
    if (!msg) return res.status(400).json({ ok: false });
    const tag = [room ? `room:${room}` : null, player ? `player:${player}` : null].filter(Boolean).join(' ');
    log(emoji || '📱', tag ? `${tag} — ${msg}` : msg, 'client');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// קבלת לוג API — JSON, לשימוש תכנותי / רענון אוטומטי במסך הלוגים
app.get('/logs', (req, res) => {
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit) || 300));
  const src = req.query.src; // 'server' | 'client' | undefined=הכל
  let items = logRing;
  if (src) items = items.filter(e => e.src === src);
  res.json({ ok: true, count: items.length, logs: items.slice(-limit) });
});

// ניקוי לוגים (רק מנהל)
app.post('/logs/clear', (req, res) => {
  const { key } = req.body || {};
  if (key !== MASTER_KEY) return res.status(403).json({ ok: false, error: 'גישה אסורה' });
  logRing = [];
  try { ensureLogsDir(); fs.writeFileSync(LOG_FILE, ''); } catch {}
  log('🗑️', 'הלוגים נוקו ע"י מנהל');
  res.json({ ok: true });
});

// מסך לוגים — HTML, נגיש דרך כפתור בממשק
app.get('/logs/page', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>לוגים — Trivia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background:#0f1117; color:#e6e6e6; margin:0; padding:0; }
  header { position:sticky; top:0; background:#161922; padding:12px 16px; border-bottom:1px solid #2a2e3a; display:flex; gap:8px; align-items:center; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:1rem; margin:0; flex:1; }
  button, select, input[type=text] { font-family:inherit; font-size:0.85rem; padding:8px 12px; border-radius:8px; border:1px solid #2a2e3a; background:#1c2030; color:#e6e6e6; cursor:pointer; }
  button:hover { background:#262b3d; }
  button.active { background:#3a5fff; border-color:#3a5fff; }
  #logs { padding:8px 16px 40px; max-width:1100px; margin:0 auto; }
  .row { display:flex; gap:10px; padding:6px 8px; border-bottom:1px solid #1c2030; font-size:0.82rem; line-height:1.5; }
  .row:hover { background:#161922; }
  .row.src-client { border-right:3px solid #3a5fff; }
  .row.src-server { border-right:3px solid #2ecc71; }
  .time { color:#888; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .src-badge { font-size:0.7rem; padding:1px 6px; border-radius:6px; background:#262b3d; color:#aaa; white-space:nowrap; height:fit-content; }
  .msg { flex:1; word-break:break-word; }
  .empty { text-align:center; color:#777; padding:40px; }
  #toolbar2 { display:flex; gap:8px; padding:10px 16px; flex-wrap:wrap; align-items:center; background:#13151c; border-bottom:1px solid #2a2e3a;}
  #toolbar2 input[type=text] { flex:1; min-width:160px; }
  .count { color:#888; font-size:0.8rem; }
</style>
</head>
<body>
<header>
  <h1>📋 לוגים — Trivia</h1>
  <button id="btn-auto" class="active" onclick="toggleAuto()">🔄 רענון אוטומטי</button>
  <button onclick="loadLogs()">↻ רענן עכשיו</button>
  <button onclick="downloadLogs()">⬇ הורד קובץ</button>
  <button onclick="clearLogs()" style="border-color:#c0392b;color:#ff8a80;">🗑️ נקה לוגים</button>
</header>
<div id="toolbar2">
  <button id="f-all" class="active" onclick="setFilter(null)">הכל</button>
  <button id="f-server" onclick="setFilter('server')">שרת</button>
  <button id="f-client" onclick="setFilter('client')">דפדפן</button>
  <input type="text" id="search" placeholder="חיפוש בטקסט..." oninput="render()">
  <span class="count" id="count"></span>
</div>
<div id="logs"><div class="empty">טוען...</div></div>
<script>
let allLogs = [];
let filterSrc = null;
let autoOn = true;
let timer = null;

function setFilter(src) {
  filterSrc = src;
  document.querySelectorAll('#toolbar2 button').forEach(b => b.classList.remove('active'));
  document.getElementById(src ? 'f-'+src : 'f-all').classList.add('active');
  render();
}

function toggleAuto() {
  autoOn = !autoOn;
  const btn = document.getElementById('btn-auto');
  btn.classList.toggle('active', autoOn);
  if (autoOn) startAuto(); else stopAuto();
}
function startAuto() { stopAuto(); timer = setInterval(loadLogs, 2500); }
function stopAuto() { if (timer) clearInterval(timer); timer = null; }

function loadLogs() {
  fetch('/logs?limit=1000').then(r => r.json()).then(d => {
    allLogs = d.logs || [];
    render();
  }).catch(() => {});
}

function render() {
  const q = (document.getElementById('search').value || '').toLowerCase();
  let items = allLogs;
  if (filterSrc) items = items.filter(e => e.src === filterSrc);
  if (q) items = items.filter(e => (e.msg||'').toLowerCase().includes(q));
  const el = document.getElementById('logs');
  document.getElementById('count').textContent = items.length + ' שורות';
  if (!items.length) { el.innerHTML = '<div class="empty">אין לוגים תואמים</div>'; return; }
  el.innerHTML = items.slice().reverse().map(e => {
    const time = (e.t || '').replace('T',' ').replace('Z','').slice(0,23);
    return '<div class="row src-'+(e.src||'server')+'">' +
      '<span class="time">'+time+'</span>' +
      '<span class="src-badge">'+(e.src==='client'?'דפדפן':'שרת')+'</span>' +
      '<span class="msg">'+ (e.emoji||'') +' '+ escapeHtml(e.msg||'') +'</span>' +
    '</div>';
  }).join('');
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function downloadLogs() {
  const lines = allLogs.map(e => '['+e.t+'] ['+(e.src||'server')+'] '+(e.emoji||'')+' '+(e.msg||''));
  const blob = new Blob([lines.join('\\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trivia-logs-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt';
  a.click();
}

function clearLogs() {
  const key = prompt('סיסמת מנהל לניקוי הלוגים:');
  if (!key) return;
  fetch('/logs/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key }) })
    .then(r => r.json()).then(d => {
      if (d.ok) { allLogs = []; render(); }
      else alert(d.error || 'שגיאה');
    });
}

loadLogs();
startAuto();
</script>
</body>
</html>`);
});

// ===== GATEWAY ROUTES =====
app.post('/login', (req, res) => {
  const { roomId, password } = req.body || {};
  if (!roomId || !password) return res.json({ ok: false, error: 'חסרים שם חדר וסיסמה' });

  const isMaster = password === MASTER_KEY;
  if (isMaster) {
    log('🔑', `כניסת מאסטר לחדר: ${roomId}`);
    return res.json({ ok: true, roomId, isAdmin: true, master: true });
  }

  const rooms = loadRooms();
  if (!rooms[roomId]) return res.json({ ok: false, error: 'חדר לא קיים. בקש מהמנהל ליצור אותו.' });
  if (rooms[roomId].password !== password) return res.json({ ok: false, error: 'סיסמה שגויה' });

  log('🚪', `כניסה לחדר: ${roomId}`);
  res.json({ ok: true, roomId, isAdmin: false });
});

app.post('/create-room', (req, res) => {
  const { roomId, password, creatorPassword } = req.body || {};
  if (creatorPassword !== MASTER_KEY) return res.json({ ok: false, error: 'רק מנהל יכול ליצור חדר' });
  if (!roomId || !password) return res.json({ ok: false, error: 'נדרש שם חדר וסיסמה' });

  const rooms = loadRooms();
  if (rooms[roomId]) return res.json({ ok: false, error: 'חדר כזה כבר קיים' });

  rooms[roomId] = { password, createdAt: new Date().toISOString() };
  saveRooms(rooms);

  // צור קובץ JSON לחדר ב-/app/data/rooms/
  const roomData = { roomId, questions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveRoomData(roomId, roomData);

  log('🏠', `חדר חדש נוצר: ${roomId}`);
  res.json({ ok: true });
});

// נתיב ציבורי — רק שמות חדרים וכמות שאלות, ללא סיסמאות (לכניסה לחדר)
app.get('/rooms-public', (req, res) => {
  const rooms = loadRooms();
  const list = Object.entries(rooms).map(([id]) => {
    const data = loadRoomData(id);
    return { id, questionCount: data.questions?.length || 0 };
  });
  res.json(list);
});

app.get('/rooms', (req, res) => {
  const { key } = req.query;
  if (key !== MASTER_KEY) return res.status(403).json({ error: 'אין גישה' });
  const rooms = loadRooms();
  // הוסף מספר שאלות לכל חדר
  const list = Object.entries(rooms).map(([id, r]) => {
    const data = loadRoomData(id);
    return { id, createdAt: r.createdAt, questionCount: data.questions?.length || 0 };
  });
  res.json(list);
});

app.delete('/rooms/:id', (req, res) => {
  const { key } = req.query;
  if (key !== MASTER_KEY) return res.status(403).json({ error: 'אין גישה' });
  const rooms = loadRooms();
  if (!rooms[req.params.id]) return res.json({ ok: false, error: 'חדר לא קיים' });
  delete rooms[req.params.id];
  saveRooms(rooms);
  // מחק גם את קובץ החדר
  try { const fp = roomFilePath(req.params.id); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  res.json({ ok: true });
});

// ===== ניהול שאלות חדר =====

// קבל את כל השאלות של חדר
app.get('/room-data/:roomId', (req, res) => {
  const { roomId } = req.params;
  const rooms = loadRooms();
  // גישה לחדר: צריך להיות חדר קיים, או מנהל (roomId יכול להיות כל חדר למנהל)
  if (!rooms[roomId]) return res.status(404).json({ error: 'חדר לא קיים' });
  res.json(loadRoomData(roomId));
});

// ===== ROOM AUTH MIDDLEWARE =====
// בדיקת הרשאות לשינוי תוכן חדר: צריך סיסמת חדר או סיסמת מנהל
function checkRoomAuth(req, res, next) {
  const { roomId } = req.params;
  const { key, password } = req.body || {};
  // מנהל מותר תמיד
  if (key === MASTER_KEY || password === MASTER_KEY) return next();
  // בעל החדר מותר עם סיסמת החדר
  const rooms = loadRooms();
  if (!rooms[roomId]) return res.status(404).json({ ok: false, error: 'חדר לא קיים' });
  const roomPass = rooms[roomId].password;
  // אם לחדר אין סיסמה — כולם מורשים
  if (!roomPass) return next();
  // אם לחדר יש סיסמה — חייבים לשלוח אותה נכון
  if (password && password === roomPass) return next();
  return res.status(403).json({ ok: false, error: 'גישה אסורה — סיסמת חדר שגויה' });
}

// הוסף שאלות מהמאגר לחדר (העתקה — המאגר לא משתנה)
app.post('/room-data/:roomId/add-from-pool', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { questions: newQs } = req.body || {};
  if (!Array.isArray(newQs) || newQs.length === 0) return res.json({ ok: false, error: 'אין שאלות' });

  const data = loadRoomData(roomId);
  // מנע כפילויות לפי טקסט השאלה
  const existing = new Set(data.questions.map(q => q.q));
  const toAdd = newQs.filter(q => !existing.has(q.q)).map(q => ({ ...q, _source: 'pool' }));
  data.questions.push(...toAdd);
  saveRoomData(roomId, data);
  res.json({ ok: true, added: toAdd.length, total: data.questions.length });
});

// הוסף שאלה ידנית לחדר
app.post('/room-data/:roomId/add-custom', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { q, a, correct, topic } = req.body || {};
  if (!q || !Array.isArray(a) || a.length < 2) return res.json({ ok: false, error: 'שאלה לא תקינה' });

  const data = loadRoomData(roomId);
  const newQ = { q, a, correct: correct || 0, topic: topic || 'אישי', _source: 'custom', _id: Date.now() };
  data.questions.push(newQ);
  saveRoomData(roomId, data);
  res.json({ ok: true, question: newQ, total: data.questions.length });
});

// מחק שאלה מחדר (לפי אינדקס)
app.delete('/room-data/:roomId/question/:idx', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const idx = parseInt(req.params.idx);
  const data = loadRoomData(roomId);
  if (isNaN(idx) || idx < 0 || idx >= data.questions.length) return res.json({ ok: false, error: 'אינדקס לא חוקי' });
  data.questions.splice(idx, 1);
  saveRoomData(roomId, data);
  res.json({ ok: true, total: data.questions.length });
});

// עדכן שאלה בחדר
app.put('/room-data/:roomId/question/:idx', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const idx = parseInt(req.params.idx);
  const data = loadRoomData(roomId);
  if (isNaN(idx) || idx < 0 || idx >= data.questions.length) return res.json({ ok: false, error: 'אינדקס לא חוקי' });
  data.questions[idx] = { ...data.questions[idx], ...req.body, _source: data.questions[idx]._source };
  saveRoomData(roomId, data);
  res.json({ ok: true });
});

// נקה את כל שאלות החדר
app.delete('/room-data/:roomId/questions', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const data = loadRoomData(roomId);
  data.questions = [];
  data.activeCategories = undefined;
  saveRoomData(roomId, data);
  res.json({ ok: true });
});

// מחק כל שאלות קטגוריה מסוימת מהחדר (לא פוגע במאגר)
app.delete('/room-data/:roomId/category/:cat', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const cat = decodeURIComponent(req.params.cat);
  const data = loadRoomData(roomId);
  const before = data.questions.length;
  data.questions = data.questions.filter(q => q.topic !== cat);
  // הסר מ-activeCategories גם
  if (Array.isArray(data.activeCategories)) {
    data.activeCategories = data.activeCategories.filter(c => c !== cat);
  }
  saveRoomData(roomId, data);
  res.json({ ok: true, removed: before - data.questions.length, total: data.questions.length });
});

// קבל קטגוריות פעילות
app.get('/room-data/:roomId/active-categories', (req, res) => {
  const { roomId } = req.params;
  const rooms = loadRooms();
  if (!rooms[roomId]) return res.status(404).json({ error: 'חדר לא קיים' });
  const data = loadRoomData(roomId);
  const allCats = [...new Set((data.questions || []).map(q => q.topic).filter(Boolean))];
  const active = Array.isArray(data.activeCategories) ? data.activeCategories : allCats;
  res.json({ ok: true, activeCategories: active, allCategories: allCats });
});

// עדכן קטגוריות פעילות
app.post('/room-data/:roomId/active-categories', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { activeCategories } = req.body || {};
  if (!Array.isArray(activeCategories)) return res.json({ ok: false, error: 'activeCategories חייב להיות מערך' });
  const data = loadRoomData(roomId);
  data.activeCategories = activeCategories;
  saveRoomData(roomId, data);
  res.json({ ok: true, activeCategories });
});

// ===== ניהול משפטי קריין של חדר =====

app.get('/room-data/:roomId/narrator', (req, res) => {
  const { roomId } = req.params;
  const rooms = loadRooms();
  if (!rooms[roomId]) return res.status(404).json({ error: 'חדר לא קיים' });
  const data = loadRoomData(roomId);
  res.json({ ok: true, narratorPhrases: data.narratorPhrases || {} });
});

app.post('/room-data/:roomId/narrator/add', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { cat, phrase } = req.body || {};
  if (!cat || !phrase) return res.status(400).json({ ok: false, error: 'נדרש cat ו-phrase' });
  const data = loadRoomData(roomId);
  if (!data.narratorPhrases) data.narratorPhrases = {};
  if (!data.narratorPhrases[cat]) data.narratorPhrases[cat] = [];
  data.narratorPhrases[cat].push(phrase);
  saveRoomData(roomId, data);
  log('🎙️', `חדר "${roomId}" — נוסף משפט קריין לקטגוריה "${cat}"`);
  res.json({ ok: true, total: data.narratorPhrases[cat].length });
});

app.post('/room-data/:roomId/narrator/set-cat', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { cat, phrases } = req.body || {};
  if (!cat || !Array.isArray(phrases)) return res.status(400).json({ ok: false, error: 'נדרש cat ו-phrases' });
  const data = loadRoomData(roomId);
  if (!data.narratorPhrases) data.narratorPhrases = {};
  data.narratorPhrases[cat] = phrases;
  saveRoomData(roomId, data);
  log('✏️', `חדר "${roomId}" — עדכון קטגוריית קריין "${cat}" (${phrases.length} משפטים)`);
  res.json({ ok: true, total: phrases.length });
});

app.delete('/room-data/:roomId/narrator/:cat/:idx', checkRoomAuth, (req, res) => {
  const { roomId, cat } = req.params;
  const idx = parseInt(req.params.idx);
  const data = loadRoomData(roomId);
  if (!data.narratorPhrases || !data.narratorPhrases[cat]) return res.status(404).json({ ok: false, error: 'קטגוריה לא קיימת' });
  if (isNaN(idx) || idx < 0 || idx >= data.narratorPhrases[cat].length) return res.status(400).json({ ok: false, error: 'אינדקס לא חוקי' });
  data.narratorPhrases[cat].splice(idx, 1);
  saveRoomData(roomId, data);
  log('🗑️', `חדר "${roomId}" — נמחק משפט קריין מ-"${cat}" (אינדקס ${idx})`);
  res.json({ ok: true, total: data.narratorPhrases[cat].length });
});

app.post('/room-data/:roomId/narrator/import-all', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { phrases } = req.body || {};
  if (!phrases || typeof phrases !== 'object') return res.status(400).json({ ok: false, error: 'נדרש phrases object' });
  const data = loadRoomData(roomId);
  if (!data.narratorPhrases) data.narratorPhrases = {};
  let added = 0;
  for (const [cat, arr] of Object.entries(phrases)) {
    if (!Array.isArray(arr)) continue;
    if (!data.narratorPhrases[cat]) data.narratorPhrases[cat] = [];
    const existing = new Set(data.narratorPhrases[cat]);
    for (const ph of arr) {
      if (!existing.has(ph)) { data.narratorPhrases[cat].push(ph); added++; }
    }
  }
  saveRoomData(roomId, data);
  log('📥', `חדר "${roomId}" — ייובאו ${added} משפטי קריין`);
  res.json({ ok: true, added });
});

// ===== עריכת משפט קריין בחדר =====
app.put('/room-data/:roomId/narrator/:cat/:idx', checkRoomAuth, (req, res) => {
  const { roomId, cat } = req.params;
  const idx = parseInt(req.params.idx);
  const { phrase } = req.body || {};
  if (!phrase) return res.status(400).json({ ok: false, error: 'נדרש phrase' });
  const data = loadRoomData(roomId);
  if (!data.narratorPhrases || !data.narratorPhrases[cat]) return res.status(404).json({ ok: false, error: 'קטגוריה לא קיימת' });
  if (isNaN(idx) || idx < 0 || idx >= data.narratorPhrases[cat].length) return res.status(400).json({ ok: false, error: 'אינדקס לא חוקי' });
  data.narratorPhrases[cat][idx] = phrase;
  saveRoomData(roomId, data);
  log('✏️', `חדר "${roomId}" — עריכת משפט קריין ב-"${cat}" (אינדקס ${idx})`);
  res.json({ ok: true });
});

// ===== איפוס קריין חדר לברירת מחדל =====
app.delete('/room-data/:roomId/narrator', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const data = loadRoomData(roomId);
  data.narratorPhrases = {};
  saveRoomData(roomId, data);
  log('↺', `חדר "${roomId}" — קריין אופס לברירת מחדל`);
  res.json({ ok: true });
});

// ===== ניהול אנשי קשר של חדר =====

// קבל את כל אנשי הקשר של חדר (ללא אימות — כל בעל חדר יכול לראות)
app.get('/room-data/:roomId/contacts', (req, res) => {
  const { roomId } = req.params;
  const rooms = loadRooms();
  if (!rooms[roomId]) return res.status(404).json({ error: 'חדר לא קיים' });
  const data = loadRoomData(roomId);
  res.json({ ok: true, contacts: data.contacts || {} });
});

// הוסף / עדכן איש קשר בחדר
app.post('/room-data/:roomId/contacts', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const { phone, name } = req.body || {};
  if (!phone || !name) return res.status(400).json({ ok: false, error: 'נדרש טלפון ושם' });
  const data = loadRoomData(roomId);
  if (!data.contacts) data.contacts = {};
  data.contacts[phone] = name;
  saveRoomData(roomId, data);
  // עדכן גם את השחקן אם מחובר
  Object.values(players).forEach(p => {
    if (p.phone === phone) { p.name = name; broadcast({ type: 'playerUpdate', callId: p.callId, name }); }
  });
  log('👤', `חדר "${roomId}" — איש קשר עודכן: ${phone} → ${name}`);
  res.json({ ok: true });
});

// מחק איש קשר מחדר
app.delete('/room-data/:roomId/contacts/:phone', checkRoomAuth, (req, res) => {
  const { roomId } = req.params;
  const phone = decodeURIComponent(req.params.phone);
  const data = loadRoomData(roomId);
  if (!data.contacts || !data.contacts[phone]) return res.json({ ok: false, error: 'לא נמצא' });
  delete data.contacts[phone];
  saveRoomData(roomId, data);
  log('🗑️', `חדר "${roomId}" — איש קשר נמחק: ${phone}`);
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  log('🚀', `שרת רץ על פורט ${PORT}`);
  loadNames();
  // הורדת מודל Piper בפעם הראשונה (אם לא קיים) + בדיקת תקינות
  await ensurePiperVoice();
  fetchTTSOnce('בדיקה', 'edge:avri', 1.0).then(buf => {
    log('✅', `Piper TTS: ניגון לדוגמה הצליח (${buf.length} בתים)`);
  }).catch(e => {
    log('🔇', `Piper TTS: ניגון לדוגמה נכשל — ${e.message.slice(0,300)}`);
  });
});

// ===== NON-TRIVIA GAMES =====

// משחק תגובה מהירה
let reactionTarget = null;
let reactionTimer = null;
let reactionRound = 0;

function startReactionGame() {
  gameState = 'playing';
  gameMode = 'reaction';
  reactionRound = 0;
  Object.values(players).forEach(p => { p.score=0; p.correct=0; p.answered=false; p._chosen=null; });
  broadcast({ type: 'gameStart', total: 8, topic: '', mode: 'reaction' });
  setTimeout(nextReactionRound, 2000);
}

function nextReactionRound() {
  if (gameState !== 'playing') return;
  if (reactionRound >= 8) { endGame(); return; }
  reactionRound++;
  reactionTarget = Math.floor(Math.random() * 4) + 1; // 1-4
  Object.values(players).forEach(p => { p.answered=false; p._chosen=null; });
  broadcast({ type: 'reaction', round: reactionRound, total: 8, target: reactionTarget });
  clearTimeout(reactionTimer);
  reactionTimer = setTimeout(() => {
    broadcast({ type: 'reactionReveal', target: reactionTarget, round: reactionRound });
    setTimeout(nextReactionRound, 3000);
  }, 5000);
}

function handleReactionAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true;
  player._chosen = chosen;
  const correct = chosen === reactionTarget;
  if (correct) {
    const prevCorrect = Object.values(players).filter(p=>p._chosen===reactionTarget&&p.answered&&p.callId!==player.callId).length;
    const pts = prevCorrect === 0 ? 100 : prevCorrect === 1 ? 70 : 40;
    player.score += pts; player.correct++;
    broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, pts, first: prevCorrect===0, mode: 'reaction' });
  } else {
    broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, pts: 0, mode: 'reaction' });
  }
  const allAnswered = Object.values(players).every(p=>p.answered);
  if (allAnswered) { clearTimeout(reactionTimer); setTimeout(()=>{ broadcast({ type:'reactionReveal', target: reactionTarget, round: reactionRound }); setTimeout(nextReactionRound, 2500); }, 800); }
}

// משחק נחש את המספר
let secretNumber = 0;
let numberRound = 0;
let numberGuesses = {};

function startNumberGame() {
  gameState = 'playing';
  gameMode = 'number';
  Object.values(players).forEach(p => { p.score=0; p.correct=0; p.answered=false; });
  numberRound = 0;
  broadcast({ type: 'gameStart', total: 5, topic: '', mode: 'number' });
  setTimeout(nextNumberRound, 1500);
}

function nextNumberRound() {
  if (numberRound >= 5) { endGame(); return; }
  numberRound++;
  secretNumber = Math.floor(Math.random() * 100) + 1;
  numberGuesses = {};
  Object.values(players).forEach(p => { p.answered=false; p._chosen=null; });
  log('🔢', `סיבוב ${numberRound} — מספר סודי: ${secretNumber}`);
  broadcast({ type: 'numberRound', round: numberRound, total: 5, min: 1, max: 100 });
  clearTimeout(questionTimer);
  questionTimer = setTimeout(() => revealNumberRound(), 20000);
}

function handleNumberGuess(player, chosen) {
  // 1=נמוך (1-25), 2=בינוני-נמוך(26-50), 3=בינוני-גבוה(51-75), 4=גבוה(76-100)
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const ranges = [[1,25],[26,50],[51,75],[76,100]];
  const [lo,hi] = ranges[chosen-1];
  const hit = secretNumber >= lo && secretNumber <= hi;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: hit, mode: 'number' });
  if (hit) { player.score += 100; player.correct++; }
  const allAnswered = Object.values(players).every(p=>p.answered);
  if (allAnswered) { clearTimeout(questionTimer); setTimeout(revealNumberRound, 1500); }
}

function revealNumberRound() {
  clearTimeout(questionTimer);
  broadcast({ type: 'numberReveal', secret: secretNumber, round: numberRound, players: Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct})) });
  setTimeout(nextNumberRound, 4000);
}

// עדכון startGame לתמוך במשחקים חדשים (routes רשומות אחרי app init)

// ===== WORD CHAIN GAME =====
const WC_CATEGORIES = [
  {label:'חיות', q:'4 חיות — לחצו על כולן!', opts:['ארי','פיל','נמר','זאב']},
  {label:'פירות', q:'4 פירות — לחצו על כולם!', opts:['תפוח','בננה','ענבים','אבטיח']},
  {label:'ערים בישראל', q:'4 ערים בישראל — לחצו על כולן!', opts:['ירושלים','תל אביב','חיפה','באר שבע']},
  {label:'חגים יהודיים', q:'4 חגים יהודיים — לחצו על כולם!', opts:['פסח','שבועות','סוכות','פורים']},
  {label:'צבעים', q:'4 צבעים — לחצו על כולם!', opts:['אדום','כחול','ירוק','צהוב']},
  {label:'מדינות', q:'4 מדינות בעולם — לחצו על כולן!', opts:['ישראל','ארה\"ב','צרפת','יפן']},
  {label:'נביאים', q:'4 נביאים מהתנ"ך — לחצו על כולם!', opts:['ישעיה','ירמיה','יחזקאל','עמוס']},
  {label:'מלכי ישראל', q:'4 מלכי ישראל — לחצו על כולם!', opts:['שאול','דוד','שלמה','ירבעם']},
  {label:'כלי נגינה', q:'4 כלי נגינה — לחצו על כולם!', opts:['כינור','חליל','תוף','גיטרה']},
  {label:'ספרי תורה', q:'4 ספרי התורה — לחצו על כולם!', opts:['בראשית','שמות','ויקרא','דברים']},
  {label:'ספורט', q:'4 ענפי ספורט — לחצו על כולם!', opts:['כדורגל','כדורסל','טניס','שחייה']},
  {label:'בעלי חיים ים', q:'4 בעלי חיים בים — לחצו על כולם!', opts:['דג','לוויתן','כריש','תמנון']},
];

let wcRound = 0, wcTimer = null;

function startWordChain() {
  gameState = 'playing'; gameMode = 'wordchain';
  wcRound = 0;
  Object.values(players).forEach(p => { p.score=0; p.correct=0; p.answered=false; p._chosen=null; p._eliminated=false; });
  broadcast({ type: 'gameStart', total: WC_CATEGORIES.length, topic: '', mode: 'wordchain' });
  setTimeout(nextWCRound, 1500);
}

function nextWCRound() {
  if (gameState !== 'playing') return;
  if (wcRound >= WC_CATEGORIES.length) { endGame(); return; }
  const cat = WC_CATEGORIES[wcRound]; wcRound++;
  Object.values(players).filter(p=>!p._eliminated).forEach(p => { p.answered=false; p._chosen=null; });
  broadcast({ type: 'wordchain', round: wcRound, total: WC_CATEGORIES.length, category: cat, timeLimit: 8 });
  clearTimeout(wcTimer);
  wcTimer = setTimeout(() => {
    // Eliminate slow players
    Object.values(players).filter(p=>!p._eliminated&&!p.answered).forEach(p => {
      p._eliminated = true;
      broadcast({ type: 'playerEliminated', playerName: p.name, callId: p.callId });
    });
    broadcast({ type: 'reactionReveal', target: 0, round: wcRound });
    setTimeout(nextWCRound, 3000);
  }, 8000);
}

function handleWCAnswer(player, chosen) {
  if (player.answered || player._eliminated) return;
  player.answered = true; player._chosen = chosen;
  player.score += 50; player.correct++;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: true, mode: 'wordchain' });
  const active = Object.values(players).filter(p=>!p._eliminated);
  if (active.every(p=>p.answered)) { clearTimeout(wcTimer); setTimeout(nextWCRound, 2000); }
}

// ===== MAJORITY GAME =====
const MAJORITY_QUESTIONS = [
  {q:'מה עדיף לאכול בבוקר?', opts:['ביצים','דגנים','פירות','יוגורט']},
  {q:'איזה חג הכי כיף?', opts:['פסח','פורים','חנוכה','סוכות']},
  {q:'איזה ספר הכי חשוב?', opts:['תורה','תלמוד','תנ\"ך','שולחן ערוך']},
  {q:'איפה הכי טוב לגור בישראל?', opts:['ירושלים','תל אביב','חיפה','בדרום']},
  {q:'מה הזמן הכי טוב ללמוד?', opts:['בוקר','צהריים','ערב','לילה']},
  {q:'איזה מאכל ישראלי הכי טעים?', opts:['חומוס','שקשוקה','פלאפל','שניצל']},
  {q:'מה עדיף — ים או הרים?', opts:['ים','הרים','מדבר','עיר']},
  {q:'כמה ילדים זה אידיאלי?', opts:['2','4','6','יותר מ-6']},
];

let majRound = 0, majTimer2 = null, majCounts = [];

function startMajority() {
  gameState = 'playing'; gameMode = 'majority';
  majRound = 0;
  Object.values(players).forEach(p => { p.score=0; p.correct=0; p.answered=false; p._chosen=null; });
  broadcast({ type: 'gameStart', total: MAJORITY_QUESTIONS.length, topic: '', mode: 'majority' });
  setTimeout(nextMajRound, 1500);
}

function nextMajRound() {
  if (gameState !== 'playing') return;
  if (majRound >= MAJORITY_QUESTIONS.length) { endGame(); return; }
  const q = MAJORITY_QUESTIONS[majRound]; majRound++;
  majCounts = [0,0,0,0];
  Object.values(players).forEach(p => { p.answered=false; p._chosen=null; });
  broadcast({ type: 'majorityRound', round: majRound, total: MAJORITY_QUESTIONS.length, question: q.q, options: q.opts });
  clearTimeout(majTimer2);
  majTimer2 = setTimeout(revealMajority, 15000);
}

function handleMajorityAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  majCounts[chosen]++;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: false, mode: 'majority' });
  if (Object.values(players).every(p=>p.answered)) { clearTimeout(majTimer2); setTimeout(revealMajority, 1000); }
}

function revealMajority() {
  clearTimeout(majTimer2);
  const maxVotes = Math.max(...majCounts);
  const majorityIdx = majCounts.indexOf(maxVotes);
  const q = MAJORITY_QUESTIONS[majRound-1];
  // Give points to majority voters
  Object.values(players).forEach(p => {
    if (p._chosen === majorityIdx) { p.score += 100; p.correct++; }
  });
  broadcast({ type: 'majorityReveal', counts: majCounts, majorityIdx, majorityOption: q.opts[majorityIdx],
    players: Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct})) });
  setTimeout(nextMajRound, 4000);
}


// ===== WHO SAID IT GAME =====
const WHO_SAID = [
  {quote:"האדם חופשי להיות מה שהוא רוצה להיות",opts:['בן גוריון','הרצל','ז׳בוטינסקי','ויצמן'],correct:1},
  {quote:"אם תרצו — אין זו אגדה",opts:['הרצל','בן גוריון','ויצמן','ז׳בוטינסקי'],correct:0},
  {quote:"כל הנשמה תהלל יה",opts:['תהילים','ישעיה','ירמיה','דברים'],correct:0},
  {quote:"לא תרצח, לא תנאף, לא תגנוב",opts:['שמות','ויקרא','דברים','בראשית'],correct:0},
  {quote:"ואהבת לרעך כמוך",opts:['דברים','ויקרא','שמות','בראשית'],correct:1},
  {quote:"עם ישראל חי",opts:['בן גוריון','הרב קוק','עם ישראל','בית יוסף'],correct:2},
  {quote:"שמע ישראל ה אלוהינו ה אחד",opts:['בראשית','שמות','ויקרא','דברים'],correct:3},
  {quote:"ובחרת בחיים",opts:['שמות','ויקרא','במדבר','דברים'],correct:3},
];

let whoRound=0, whoTimer=null;

function startWhoSaid() {
  gameState='playing'; gameMode='whosaid';
  whoRound=0;
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;});
  broadcast({type:'gameStart',total:WHO_SAID.length,topic:'',mode:'whosaid'});
  setTimeout(nextWhoRound,1500);
}

function nextWhoRound() {
  if(whoRound>=WHO_SAID.length){endGame();return;}
  const q=WHO_SAID[whoRound]; whoRound++;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'whoRound',round:whoRound,total:WHO_SAID.length,quote:q.quote,opts:q.opts,timeLimit:20});
  clearTimeout(whoTimer);
  whoTimer=setTimeout(()=>{
    // reveal
    const correct=WHO_SAID[whoRound-1].correct;
    Object.values(players).filter(p=>p._chosen===correct).forEach(p=>{p.score+=100;p.correct++;});
    broadcast({type:'whoReveal',correct,correctText:WHO_SAID[whoRound-1].opts[correct],
      players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
    setTimeout(nextWhoRound,3500);
  },20000);
}

function handleWhoAnswer(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const q=WHO_SAID[whoRound-1];
  const isCorrect=chosen===q.correct;
  if(isCorrect){player.score+=100;player.correct++;}
  broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct:isCorrect,mode:'whosaid'});
  if(Object.values(players).every(p=>p.answered)){clearTimeout(whoTimer);
    broadcast({type:'whoReveal',correct:q.correct,correctText:q.opts[q.correct],
      players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
    setTimeout(nextWhoRound,3500);
  }
}

// ===== LIGHTNING ROUND (חידון ברק) =====
// 20 שאלות, 3 שניות כל אחת, ניקוד בונוס עולה עם רצף
let lightRound=0, lightTimer=null;

function startLightning() {
  gameState='playing'; gameMode='lightning';
  lightRound=0;
  const allQ=loadQuestions();
  questions=shuffle(allQ).slice(0,20);
  currentQuestion=0;
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;p._streak=0;});
  broadcast({type:'gameStart',total:questions.length,topic:'',mode:'lightning'});
  setTimeout(showLightningQ,1500);
}

function showLightningQ(){
  if(gameState !== 'playing') return;
  if(currentQuestion>=questions.length){endGame();return;}
  const q=questions[currentQuestion];
  firstCorrect=null;
  questionTimeLeft=3;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'question',index:currentQuestion,total:questions.length,question:q.q,answers:q.a,topic:q.topic,mode:'lightning',timeLimit:3});
  clearTimeout(questionTimer);
  questionTimer=setTimeout(()=>{
    const correct=questions[currentQuestion].correct;
    Object.values(players).forEach(p=>{
      if(p._chosen===correct){p._streak=(p._streak||0)+1;const bonus=Math.min(p._streak*15,75);p.score+=50+bonus;p.correct++;}
      else{p._streak=0;}
    });
    broadcast({type:'reveal',correct,correctText:q.a[correct],mode:'lightning',
      players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
    currentQuestion++;
    if(gameState==='playing') setTimeout(showLightningQ,2000);
  },3000);
  let tl=3;const tlInt=setInterval(()=>{tl--;questionTimeLeft=tl;if(tl<=0)clearInterval(tlInt);},1000);
}

function handleLightningAnswer(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const q=questions[currentQuestion];
  const isCorrect=chosen===q.correct;
  broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct:isCorrect,mode:'lightning'});
}

app.get('/start-wordchain', (req, res) => { startWordChain(); res.send('ok'); });
app.get('/start-majority', (req, res) => { startMajority(); res.send('ok'); });
app.get('/start-reaction', (req, res) => { startReactionGame(); res.send('ok'); });
app.get('/start-number', (req, res) => { startNumberGame(); res.send('ok'); });

// ===== PRICE IS RIGHT =====
const PRICE_Q = [
  {q:'כמה עולה כיכר לחם בסופר?', secret:7, unit:'ש"ח', opts:[4,7,12,18]},
  {q:'כמה עולה ליטר חלב?', secret:8, unit:'ש"ח', opts:[5,8,13,20]},
  {q:'כמה עולה כרטיס אוטובוס עירוני?', secret:6, unit:'ש"ח', opts:[3,6,10,15]},
  {q:'כמה עולה ממוצע ארוחה במסעדה?', secret:70, unit:'ש"ח', opts:[30,50,70,120]},
  {q:'כמה עולה כרטיס קולנוע?', secret:45, unit:'ש"ח', opts:[25,35,45,65]},
  {q:'כמה עולה בנזין לליטר?', secret:7, unit:'ש"ח', opts:[4,6,7,9]},
  {q:'כמה שקלים שווה דולר אחד?', secret:37, unit:'ש"ח', opts:[25,32,37,45]},
  {q:'כמה עולה חבילת גבינה לבנה?', secret:12, unit:'ש"ח', opts:[7,10,12,18]},
];
let priceRound=0, priceTimer=null;

function startPrice() {
  stopAllTimers();
  gameState='playing'; gameMode='price'; priceRound=0;
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;});
  broadcast({type:'gameStart',total:PRICE_Q.length,topic:'',mode:'price'});
  setTimeout(nextPriceRound,1500);
}
function nextPriceRound(){
  if(gameState!=='playing')return;
  if(priceRound>=PRICE_Q.length){endGame();return;}
  const q=PRICE_Q[priceRound];priceRound++;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'priceRound',round:priceRound,total:PRICE_Q.length,question:q.q,unit:q.unit,opts:q.opts,secret:q.secret,timeLimit:18});
  clearTimeout(priceTimer);
  priceTimer=setTimeout(revealPrice,18000);
}
function revealPrice(){
  clearTimeout(priceTimer);
  const q=PRICE_Q[priceRound-1];
  const ci=q.opts.indexOf(q.secret);
  Object.values(players).forEach(p=>{if(p._chosen===ci){p.score+=100;p.correct++;}});
  broadcast({type:'reveal',correct:ci,correctText:q.secret+' '+q.unit,mode:'price',
    players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
  if(gameState==='playing') setTimeout(nextPriceRound,4000);
}
function handlePriceAns(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const q=PRICE_Q[priceRound-1];
  const correct=chosen===q.opts.indexOf(q.secret);
  broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct,mode:'price'});
  if(Object.values(players).every(p=>p.answered)){clearTimeout(priceTimer);setTimeout(revealPrice,1000);}
}

// ===== TRUE/FALSE =====
const TF_Q = [
  {q:'הר החרמון הוא ההר הגבוה ביותר בישראל', ans:true},
  {q:'בתורה יש 613 מצוות לפי הרמב"ם', ans:true},
  {q:'חנוכה נמשך שבעה ימים', ans:false},
  {q:'שבת היא היום הראשון בשבוע', ans:false},
  {q:'הכנסת מונה 120 חברים', ans:true},
  {q:'מלחמת ששת הימים הייתה ב-1973', ans:false},
  {q:'ירדן הוא הנהר הארוך בישראל', ans:true},
  {q:'ים המלח הוא הנקודה הנמוכה בעולם', ans:true},
  {q:'ראש השנה חל בחודש אלול', ans:false},
  {q:'כוכב הלכת הגדול ביותר הוא צדק', ans:true},
  {q:'מדינת ישראל הוכרזה ב-1948', ans:true},
  {q:'חג השבועות חל בחודש ניסן', ans:false},
];
let tfRound=0, tfTimer=null;

function startTrueFalse(){
  stopAllTimers();
  gameState='playing'; gameMode='truefalse'; tfRound=0;
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;});
  broadcast({type:'gameStart',total:TF_Q.length,topic:'',mode:'truefalse'});
  setTimeout(nextTFRound,1500);
}
function nextTFRound(){
  if(gameState!=='playing')return;
  if(tfRound>=TF_Q.length){endGame();return;}
  const q=TF_Q[tfRound];tfRound++;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'tfRound',round:tfRound,total:TF_Q.length,question:q.q,timeLimit:12});
  clearTimeout(tfTimer);
  tfTimer=setTimeout(revealTF,12000);
}
function revealTF(){
  clearTimeout(tfTimer);
  const q=TF_Q[tfRound-1];
  const ci=q.ans?0:1; // 0=נכון 1=לא נכון
  Object.values(players).forEach(p=>{if(p._chosen===ci){p.score+=100;p.correct++;}});
  broadcast({type:'reveal',correct:ci,correctText:q.ans?'נכון':'לא נכון',mode:'truefalse',
    players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
  if(gameState==='playing') setTimeout(nextTFRound,3500);
}
function handleTFAns(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const q=TF_Q[tfRound-1];
  const correct=chosen===(q.ans?0:1);
  broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct,mode:'truefalse'});
  if(Object.values(players).every(p=>p.answered)){clearTimeout(tfTimer);setTimeout(revealTF,800);}
}


// ===== EMOJI QUIZ =====
const EMOJI_Q = [
  {emoji:'🍎📱💻',answer:'אפל',opts:['אפל','גוגל','מיקרוסופט','סמסונג'],correct:0},
  {emoji:'🦁👑🌍',answer:'מלך האריות',opts:['מלך האריות','טרזן','ספר הג\'ונגל','הדב פו'],correct:0},
  {emoji:'🧊❄️👸',answer:'פרוזן',opts:['שלגיה','פרוזן','נסיכת הים','יפהפייה'],correct:1},
  {emoji:'🕷️👨🏙️',answer:'ספיידרמן',opts:['באטמן','ספיידרמן','סופרמן','אנטמן'],correct:1},
  {emoji:'🚀⭐🌌',answer:'מלחמת הכוכבים',opts:['אינטרסטלר','מלחמת הכוכבים','שליחות בלתי אפשרית','מאדים'],correct:1},
  {emoji:'🍕🇮🇹👨‍🍳',answer:'איטליה',opts:['צרפת','ספרד','איטליה','יוון'],correct:2},
  {emoji:'🌙⭐✡️',answer:'ישראל',opts:['ישראל','מרוקו','טורקיה','פקיסטן'],correct:0},
  {emoji:'🐘🌿🌍',answer:'אפריקה',opts:['הודו','אפריקה','דרום אמריקה','אוסטרליה'],correct:1},
  {emoji:'📖🪄⚡',answer:'הארי פוטר',opts:['הארי פוטר','נרניה','מלחמת הכוכבים','שר הטבעות'],correct:0},
  {emoji:'🎸🎵🤘',answer:'רוק',opts:["ג'אז",'קלאסי','רוק','פופ'],correct:2},
  {emoji:'🕯️🍩8️⃣',answer:'חנוכה',opts:['פסח','פורים','חנוכה','שבועות'],correct:2},
  {emoji:'🌹🌹🌹',answer:'ורד',opts:['צבעוני','ורד','חמנייה','לוטוס'],correct:1},
  {emoji:'⚽🏆🥇',answer:'מונדיאל',opts:['אולימפיאדה','מונדיאל','אירוביזיון','ליגת אלופות'],correct:1},
  {emoji:'🐫🏜️🌞',answer:'מדבר',opts:['ג\'ונגל','מדבר','ערבה','נגב'],correct:1},
];
let emojiRound=0, emojiTimer=null, emojiActiveQ=[];

function startEmoji(){
  stopAllTimers();
  gameState='playing'; gameMode='emoji'; emojiRound=0;
  emojiActiveQ=[...EMOJI_Q].sort(()=>Math.random()-0.5).slice(0,10);
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;});
  broadcast({type:'gameStart',total:10,topic:'',mode:'emoji'});
  setTimeout(nextEmojiRound,1500);
}
function nextEmojiRound(){
  if(gameState!=='playing')return;
  if(emojiRound>=emojiActiveQ.length){endGame();return;}
  const q=emojiActiveQ[emojiRound];emojiRound++;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'emojiRound',round:emojiRound,total:emojiActiveQ.length,emoji:q.emoji,opts:q.opts,timeLimit:15});
  clearTimeout(emojiTimer);
  emojiTimer=setTimeout(revealEmoji,15000);
}
function revealEmoji(){
  clearTimeout(emojiTimer);
  const q=emojiActiveQ[emojiRound-1];
  Object.values(players).forEach(p=>{if(p._chosen===q.correct){p.score+=100;p.correct++;}});
  broadcast({type:'reveal',correct:q.correct,correctText:q.answer,mode:'emoji',
    players:Object.values(players).map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
  if(gameState==='playing') setTimeout(nextEmojiRound,4000);
}
function handleEmojiAns(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const q=emojiActiveQ[emojiRound-1];
  if(!q)return;
  const correct=chosen===q.correct;
  if(correct){player.score+=100;player.correct++;}
  broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct,mode:'emoji'});
  if(Object.values(players).every(p=>p.answered)){clearTimeout(emojiTimer);setTimeout(revealEmoji,800);}
}

// ===== HOT SEAT =====
let hotRound=0, hotTimer=null, hotSeatIdx=0;

function startHotseat(){
  stopAllTimers();
  gameState='playing'; gameMode='hotseat'; hotRound=0; currentQuestion=0;
  const pList=Object.values(players);
  hotSeatIdx=Math.floor(Math.random()*Math.max(1,pList.length));
  const hotPlayer=pList[hotSeatIdx]||null;
  const allQ=loadQuestions();
  questions=shuffle(allQ).slice(0,5);
  Object.values(players).forEach(p=>{p.score=0;p.correct=0;p.answered=false;p._chosen=null;});
  broadcast({type:'gameStart',total:5,topic:'',mode:'hotseat'});
  if(hotPlayer) broadcast({type:'hotseatPlayer',callId:hotPlayer.callId,name:hotPlayer.name});
  setTimeout(nextHotseatQ,2000);
}
function nextHotseatQ(){
  if(gameState!=='playing')return;
  if(currentQuestion>=questions.length){endGame();return;}
  const q=questions[currentQuestion];
  const pList=Object.values(players);
  const hotPlayer=pList[hotSeatIdx%Math.max(1,pList.length)]||null;
  Object.values(players).forEach(p=>{p.answered=false;p._chosen=null;});
  broadcast({type:'question',index:currentQuestion,total:questions.length,question:q.q,answers:q.a,topic:q.topic,mode:'hotseat',timeLimit:7,hotSeat:hotPlayer?.callId});
  clearTimeout(hotTimer);
  hotTimer=setTimeout(()=>{
    const correct=questions[currentQuestion].correct;
    const pListNow=Object.values(players);
    const hotP=pListNow[hotSeatIdx%Math.max(1,pListNow.length)]||null;
    if(hotP&&hotP._chosen===correct){hotP.score+=100;hotP.correct++;}
    // Others: if bet "yes" (chose 1) and hot player correct +50
    pListNow.forEach(p=>{
      if(p===hotP)return;
      if(p._chosen===0&&hotP&&hotP._chosen===correct){p.score+=50;}
    });
    broadcast({type:'reveal',correct,correctText:q.a[correct],mode:'hotseat',
      players:pListNow.map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
    currentQuestion++;
    if(gameState==='playing') setTimeout(nextHotseatQ,3500);
  },7000);
}
function handleHotseatAns(player,chosen){
  if(player.answered)return;
  player.answered=true;player._chosen=chosen;
  const pList=Object.values(players);
  const hotPlayer=pList[hotSeatIdx%Math.max(1,pList.length)]||null;
  const isHot=hotPlayer&&hotPlayer.callId===player.callId;
  const q=questions[currentQuestion];
  if(isHot){
    const correct=chosen===q.correct;
    broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct,mode:'hotseat',isHot:true});
  } else {
    broadcast({type:'answer',playerName:player.name,phone:player.phone,chosen,correct:false,mode:'hotseat',isHot:false,bet:chosen===0?'כן':'לא'});
  }
  if(Object.values(players).every(p=>p.answered)){clearTimeout(hotTimer);
    const correct=q.correct;
    const pListNow=Object.values(players);
    const hotP=pListNow[hotSeatIdx%Math.max(1,pListNow.length)]||null;
    if(hotP&&hotP._chosen===correct){hotP.score+=100;hotP.correct++;}
    pListNow.forEach(p=>{if(p!==hotP&&p._chosen===0&&hotP&&hotP._chosen===correct){p.score+=50;}});
    broadcast({type:'reveal',correct,correctText:q.a[correct],mode:'hotseat',
      players:pListNow.map(p=>({callId:p.callId,score:p.score,correct:p.correct}))});
    currentQuestion++;
    if(gameState==='playing') setTimeout(nextHotseatQ,3500);
  }
}

app.get('/start-emoji',   (req,res)=>{startEmoji();  res.send('ok');});
app.get('/start-hotseat', (req,res)=>{startHotseat();res.send('ok');});

// ===== FAMILY GAME =====
const FAMILY_FILE = require('path').join(__dirname, 'family_questions.json');
const FAMILY_SETS_FILE = require('path').join(__dirname, 'family_sets.json');

function loadFamilyQuestions() {
  try { return JSON.parse(fs.readFileSync(FAMILY_FILE, 'utf8')); } catch { return []; }
}
function saveFamilyQuestions(qs) {
  try { fs.writeFileSync(FAMILY_FILE, JSON.stringify(qs, null, 2)); } catch(e){ log('⚠️',e.message); }
}
function loadFamilySets() {
  try { return JSON.parse(fs.readFileSync(FAMILY_SETS_FILE, 'utf8')); } catch { return []; }
}
function saveFamilySets(sets) {
  try { fs.writeFileSync(FAMILY_SETS_FILE, JSON.stringify(sets, null, 2)); } catch(e){ log('⚠️',e.message); }
}

let familyTimer = null, familyRound = 0, familyQuestions = [], familySetName = '';

function startFamily(setId) {
  stopAllTimers();
  const allFQ = loadFamilyQuestions();
  if (setId && setId !== 'all') {
    familyQuestions = shuffle(allFQ.filter(q => q.setId === setId)).slice(0, 15);
  } else {
    familyQuestions = shuffle(allFQ).slice(0, 15);
  }
  if (!familyQuestions.length) return false;
  gameState = 'playing'; gameMode = 'family'; familyRound = 0;
  const sets = loadFamilySets();
  const set = sets.find(s => s.id === setId);
  familySetName = set ? set.name : 'משפחה';
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: familyQuestions.length, topic: familySetName, mode: 'family' });
  setTimeout(nextFamilyRound, 1500);
  return true;
}

function nextFamilyRound() {
  if (gameState !== 'playing') return;
  if (familyRound >= familyQuestions.length) { endGame(); return; }
  const q = familyQuestions[familyRound]; familyRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'question', index: familyRound - 1, total: familyQuestions.length, question: q.q, answers: q.a, topic: '👨‍👩‍👧 ' + familySetName, mode: 'family', timeLimit: 25 });
  clearTimeout(familyTimer);
  familyTimer = setTimeout(() => {
    const q = familyQuestions[familyRound - 1];
    Object.values(players).filter(p => p._chosen === q.correct).forEach(p => { p.score += 100; p.correct++; });
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.a[q.correct], mode: 'family',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextFamilyRound, 4000);
  }, 25000);
}

function handleFamilyAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = familyQuestions[familyRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, pts: isCorrect ? 100 : 0, mode: 'family' });
  const active = Object.values(players).filter(p => !p._eliminated);
  if (active.every(p => p.answered)) {
    clearTimeout(familyTimer);
    setTimeout(() => {
      broadcast({ type: 'reveal', correct: q.correct, correctText: q.a[q.correct], mode: 'family',
        players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
      if (gameState === 'playing') setTimeout(nextFamilyRound, 4000);
    }, 1500);
  }
}

// Family CRUD routes
app.get('/family/questions', (req, res) => res.json(loadFamilyQuestions()));
app.get('/family/sets', (req, res) => res.json(loadFamilySets()));

app.post('/family/questions', (req, res) => {
  const { q, a, correct, setId, setName } = req.body;
  if (!q || !a || a.length !== 4 || correct === undefined || !setId) { res.status(400).json({ ok: false }); return; }
  const qs = loadFamilyQuestions();
  qs.push({ q, a, correct: parseInt(correct), setId, setName: setName || setId, id: Date.now() });
  saveFamilyQuestions(qs);
  // Auto-create set if not exists
  const sets = loadFamilySets();
  if (!sets.find(s => s.id === setId)) {
    sets.push({ id: setId, name: setName || setId, created: Date.now() });
    saveFamilySets(sets);
  }
  res.json({ ok: true, total: qs.length });
});

app.put('/family/questions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { q, a, correct, setId, setName } = req.body;
  const qs = loadFamilyQuestions();
  const idx = qs.findIndex(fq => fq.id === id);
  if (idx < 0) { res.status(404).json({ ok: false }); return; }
  qs[idx] = { ...qs[idx], q, a, correct: parseInt(correct), setId, setName };
  saveFamilyQuestions(qs);
  res.json({ ok: true });
});

app.delete('/family/questions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const qs = loadFamilyQuestions();
  const idx = qs.findIndex(fq => fq.id === id);
  if (idx < 0) { res.status(404).json({ ok: false }); return; }
  qs.splice(idx, 1);
  saveFamilyQuestions(qs);
  res.json({ ok: true });
});

app.post('/family/sets', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) { res.status(400).json({ ok: false }); return; }
  const sets = loadFamilySets();
  if (!sets.find(s => s.id === id)) { sets.push({ id, name, created: Date.now() }); saveFamilySets(sets); }
  res.json({ ok: true });
});

app.delete('/family/sets/:id', (req, res) => {
  const id = req.params.id;
  let sets = loadFamilySets(); sets = sets.filter(s => s.id !== id); saveFamilySets(sets);
  let qs = loadFamilyQuestions(); qs = qs.filter(q => q.setId !== id); saveFamilyQuestions(qs);
  res.json({ ok: true });
});

app.get('/start-family', (req, res) => {
  const setId = req.query.setId || 'all';
  const ok = startFamily(setId);
  res.writeHead(ok ? 200 : 400); res.end(ok ? 'started' : 'no questions');
});

// ===== GUESS THE SONG (ניחוש שיר) =====
const SONG_ROUNDS = [
  // ישראלי
  { clue: '🎵 לא יסוף... לא יסוף...', answer: 'לא יסוף', opts: ['לא יסוף', 'לנסוע', 'ערש ינוק', 'שיר לשלום'], correct: 0, category: 'ישראלי' },
  { clue: '🎵 שיר לשלום... לא תחזיר...', answer: 'שיר לשלום', opts: ['שיר לשלום', 'הלוויתן', 'לא תיסוף', 'שאו ציון'], correct: 0, category: 'ישראלי' },
  { clue: '🎵 ירושלים של זהב...', answer: 'ירושלים של זהב', opts: ['ירושלים שלי', 'ירושלים של זהב', 'עיר הקודש', 'שיר ירושלים'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 בשנה הבאה נשב על המרפסת...', answer: 'בשנה הבאה', opts: ['השנה הזו', 'בשנה הבאה', 'שנה טובה', 'תפילה'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 שיר ים תיכוני...', answer: 'שיר ים תיכוני', opts: ['ים תיכון', 'שיר ים תיכוני', 'שיר לים', 'הים הגדול'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 לכי לכי... יש אהבה בעיניים...', answer: 'לכי לכי', opts: ['לכי', 'לכי לכי', 'אהבה', 'עיניים'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 מה אברך... את השנה הזאת...', answer: 'מה אברך', opts: ['ברכה', 'מה אברך', 'שנה חדשה', 'תפילה לשנה'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 פרח גן עדן... פרח גן עדן...', answer: 'פרח גן עדן', opts: ['פרח בודד', 'פרח גן עדן', 'גן עדן', 'שיר הפרחים'], correct: 1, category: 'ישראלי' },
  { clue: '🎵 תן לי יד... ונלכה שנינו...', answer: 'תן לי יד', opts: ['תן לי יד', 'ביחד', 'לכה דודי', 'שנינו יחד'], correct: 0, category: 'ישראלי' },
  { clue: '🎵 כנרת... כנרת... הים הירוק...', answer: 'כנרת', opts: ['הכינרת', 'כנרת', 'ים הגליל', 'שיר לכנרת'], correct: 1, category: 'ישראלי' },

  // יהודי / דתי
  { clue: '🎵 עם ישראל חי...', answer: 'עם ישראל חי', opts: ['עם ישראל חי', 'הנה מה טוב', 'הבה נגילה', 'ירושלים של זהב'], correct: 0, category: 'יהודי' },
  { clue: '🎵 הבה נגילה... הבה נגילה ונשמחה...', answer: 'הבה נגילה', opts: ['שלום אליכם', 'הבה נגילה', 'ירושלים', 'עם ישראל חי'], correct: 1, category: 'יהודי' },
  { clue: '🎵 שלום עליכם... מלאכי השרת...', answer: 'שלום עליכם', opts: ['שלום עליכם', 'לכה דודי', 'אשת חיל', 'ויכולו'], correct: 0, category: 'יהודי' },
  { clue: '🎵 לכה דודי... לקראת כלה...', answer: 'לכה דודי', opts: ['אנה ה\'', 'לכה דודי', 'דודי לי', 'שיר השירים'], correct: 1, category: 'יהודי' },
  { clue: '🎵 חד גדיא... חד גדיא...', answer: 'חד גדיא', opts: ['חד גדיא', 'דיינו', 'מה נשתנה', 'אחד מי יודע'], correct: 0, category: 'יהודי' },
  { clue: '🎵 דיינו! דיינו! דיינו דיינו דיינו!', answer: 'דיינו', opts: ['הלל', 'דיינו', 'אחד מי יודע', 'חד גדיא'], correct: 1, category: 'יהודי' },
  { clue: '🎵 אחד מי יודע... אחד אני יודע...', answer: 'אחד מי יודע', opts: ['אחד מי יודע', 'שלושה מי יודע', 'שמע ישראל', 'חד גדיא'], correct: 0, category: 'יהודי' },
  { clue: '🎵 יגדל... יגדל אלהים חי...', answer: 'יגדל', opts: ['אדון עולם', 'יגדל', 'אלי אלי', 'מה טובו'], correct: 1, category: 'יהודי' },
  { clue: '🎵 אדון עולם... אשר מלך...', answer: 'אדון עולם', opts: ['אדון עולם', 'יגדל', 'שמע ישראל', 'לכה דודי'], correct: 0, category: 'יהודי' },
  { clue: '🎵 אנא ה\'... הושיעה נא...', answer: 'אנא ה\'', opts: ['הלל', 'אנא ה\'', 'דיינו', 'הודו לה\''], correct: 1, category: 'יהודי' },

  // עולמי / פופ
  { clue: '🎵 Happy Birthday to You...', answer: 'Happy Birthday', opts: ['Happy Birthday', 'Jingle Bells', 'We Are The World', 'Imagine'], correct: 0, category: 'עולמי' },
  { clue: '🎵 Jingle bells... jingle bells... jingle all the way!', answer: 'Jingle Bells', opts: ['Silent Night', 'Jingle Bells', 'O Christmas Tree', 'Rudolph'], correct: 1, category: 'עולמי' },
  { clue: '🎵 Imagine all the people... living life in peace...', answer: 'Imagine - John Lennon', opts: ['Imagine - John Lennon', 'Let It Be', 'Hey Jude', 'Yesterday'], correct: 0, category: 'עולמי' },
  { clue: '🎵 We are the world... we are the children...', answer: 'We Are The World', opts: ['We Are The World', 'Heal The World', 'Man In The Mirror', 'Earth Song'], correct: 0, category: 'עולמי' },
  { clue: '🎵 Can you feel the love tonight...', answer: 'Can You Feel The Love Tonight', opts: ['Circle of Life', 'Can You Feel The Love Tonight', 'Hakuna Matata', 'I Just Can\'t Wait'], correct: 1, category: 'עולמי' },
  { clue: '🎵 Let her go... only miss the sun when it starts to snow...', answer: 'Let Her Go - Passenger', opts: ['Let Her Go - Passenger', 'Stay With Me', 'Chasing Cars', 'Someone Like You'], correct: 0, category: 'עולמי' },
  { clue: '🎵 Shallow... I\'m off the deep end...', answer: 'Shallow - Lady Gaga', opts: ['A Million Dreams', 'Shallow - Lady Gaga', 'Always Remember Us', 'The Sound of Silence'], correct: 1, category: 'עולמי' },

  // רוק
  { clue: '🎵 Bohemian Rhapsody... Is this real life? Is this just fantasy?', answer: 'Bohemian Rhapsody', opts: ['Queen Medley', 'Bohemian Rhapsody', 'Stairway to Heaven', 'Hotel California'], correct: 1, category: 'רוק' },
  { clue: '🎵 We will, we will rock you!', answer: 'We Will Rock You', opts: ['We Are The Champions', 'We Will Rock You', 'Radio Gaga', 'Another One Bites'], correct: 1, category: 'רוק' },
  { clue: '🎵 Don\'t stop believing... Hold on to the feeling!', answer: 'Don\'t Stop Believin\'', opts: ['Don\'t Stop Me Now', 'Don\'t Stop Believin\'', 'Livin\' on a Prayer', 'Eye of the Tiger'], correct: 1, category: 'רוק' },
  { clue: '🎵 Eye of the tiger... it\'s the thrill of the fight!', answer: 'Eye of the Tiger', opts: ['Eye of the Tiger', 'Rocky Theme', 'Survivor', 'We Will Rock You'], correct: 0, category: 'רוק' },
  { clue: '🎵 Livin\' on a prayer... Tommy used to work on the docks...', answer: 'Livin\' on a Prayer', opts: ['Living on a Prayer', 'Livin\' on a Prayer', 'You Give Love a Bad Name', 'Shot Through the Heart'], correct: 1, category: 'רוק' },
  { clue: '🎵 Smells like teen spirit... Here we are now, entertain us!', answer: 'Smells Like Teen Spirit', opts: ['Come as You Are', 'Smells Like Teen Spirit', 'Heart-Shaped Box', 'All Apologies'], correct: 1, category: 'רוק' },
  { clue: '🎵 Sweet home Alabama... where the skies are so blue...', answer: 'Sweet Home Alabama', opts: ['Sweet Home Alabama', 'Free Bird', 'Simple Man', 'Tuesday\'s Gone'], correct: 0, category: 'רוק' },
  { clue: '🎵 Stairway to Heaven... there\'s a lady who\'s sure...', answer: 'Stairway to Heaven', opts: ['Stairway to Heaven', 'Kashmir', 'Whole Lotta Love', 'Black Dog'], correct: 0, category: 'רוק' },

  // ילדים
  { clue: '🎵 Let it go, let it go... can\'t hold it back anymore!', answer: 'Let It Go - Frozen', opts: ['Elsa\'s Song', 'Let It Be', 'Let It Go - Frozen', 'Beauty and the Beast'], correct: 2, category: 'ילדים' },
  { clue: '🎵 Twinkle twinkle little star... how I wonder what you are!', answer: 'Twinkle Twinkle', opts: ['ABC Song', 'Twinkle Twinkle', 'Mary Had a Lamb', 'Row Your Boat'], correct: 1, category: 'ילדים' },
  { clue: '🎵 Under the sea... under the sea... darling it\'s better down where it\'s wetter!', answer: 'Under the Sea - Little Mermaid', opts: ['Part of Your World', 'Under the Sea - Little Mermaid', 'Kiss the Girl', 'Poor Unfortunate Souls'], correct: 1, category: 'ילדים' },
  { clue: '🎵 Hakuna Matata... what a wonderful phrase!', answer: 'Hakuna Matata', opts: ['Circle of Life', 'Can You Feel the Love', 'Hakuna Matata', 'I Just Can\'t Wait'], correct: 2, category: 'ילדים' },
  { clue: '🎵 Be our guest, be our guest... put our service to the test!', answer: 'Be Our Guest - Beauty and the Beast', opts: ['Tale as Old as Time', 'Be Our Guest - Beauty and the Beast', 'Lumiere\'s Song', 'Something There'], correct: 1, category: 'ילדים' },
  { clue: '🎵 You\'ve got a friend in me... you\'ve got a friend in me!', answer: 'You\'ve Got a Friend in Me - Toy Story', opts: ['Woody\'s Roundup', 'You\'ve Got a Friend in Me - Toy Story', 'Strange Things', 'When She Loved Me'], correct: 1, category: 'ילדים' },
  { clue: '🎵 ראש כתפיים ברכיים ואצבעות... ברכיים ואצבעות!', answer: 'ראש כתפיים ברכיים', opts: ['ראש כתפיים ברכיים', 'הגוף שלי', 'ידיים ורגליים', 'איפה האף'], correct: 0, category: 'ילדים' },
  { clue: '🎵 פיל קטן הלך לטייל... ביום בהיר ויפה...', answer: 'פיל קטן', opts: ['הפיל', 'פיל קטן', 'ג\'ונגל', 'חיות הבר'], correct: 1, category: 'ילדים' },
];

let guessSongTimer = null, guessSongRound = 0, guessSongActive = [];

function startGuessSong() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'guesssong'; guessSongRound = 0;
  guessSongActive = shuffle([...SONG_ROUNDS]).slice(0, 10);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: guessSongActive.length, topic: '', mode: 'guesssong' });
  setTimeout(nextGuessSongRound, 1500);
}

function nextGuessSongRound() {
  if (gameState !== 'playing') return;
  if (guessSongRound >= guessSongActive.length) { endGame(); return; }
  const q = guessSongActive[guessSongRound]; guessSongRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'guessSongRound', round: guessSongRound, total: guessSongActive.length, clue: q.clue, opts: q.opts, category: q.category, timeLimit: 20 });
  clearTimeout(guessSongTimer);
  guessSongTimer = setTimeout(() => {
    const sq = guessSongActive[guessSongRound - 1];
    Object.values(players).filter(p => p._chosen === sq.correct).forEach(p => { p.score += 100; p.correct++; });
    broadcast({ type: 'reveal', correct: sq.correct, correctText: sq.answer, mode: 'guesssong',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextGuessSongRound, 4000);
  }, 20000);
}

function handleGuessSongAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = guessSongActive[guessSongRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'guesssong' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(guessSongTimer);
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.answer, mode: 'guesssong',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextGuessSongRound, 4000);
  }
}

// ===== WHO AM I? (מי אני?) =====
const WHO_AM_I_Q = [
  { clue: 'אני האדם הראשון בעולם. נבראתי ביום השישי של הבריאה.', answer: 'אדם הראשון', opts: ['אדם הראשון', 'נוח', 'אברהם', 'משה'], correct: 0 },
  { clue: 'אני בניתי תיבה ענקית והצלתי את כל בעלי החיים מהמבול.', answer: 'נוח', opts: ['אברהם', 'נוח', 'משה', 'יצחק'], correct: 1 },
  { clue: 'אני מלך ישראל הגדול. כתבתי ספר תהילים וניצחתי את גוליית.', answer: 'דוד המלך', opts: ['שלמה', 'דוד המלך', 'שאול', 'יהושע'], correct: 1 },
  { clue: 'אני הנביא שקיבל את התורה בהר סיני. הוצאתי את ישראל ממצרים.', answer: 'משה', opts: ['משה', 'אהרון', 'אברהם', 'יהושע'], correct: 0 },
  { clue: 'אני הראשון שיצא לארץ כנען. נולד לי בן בגיל 100.', answer: 'אברהם אבינו', opts: ['יצחק', 'יעקב', 'אברהם אבינו', 'נוח'], correct: 2 },
  { clue: 'אני מלך ישראל שבנה את בית המקדש. ידוע בחכמתי.', answer: 'שלמה המלך', opts: ['שלמה המלך', 'דוד', 'שאול', 'יאשיהו'], correct: 0 },
  { clue: 'הייתי ראש ממשלת ישראל הראשון. "אם תרצו — אין זו אגדה".', answer: 'בן גוריון', opts: ['הרצל', 'בן גוריון', 'ויצמן', 'שרת'], correct: 1 },
  { clue: 'חלמתי על מדינת יהודים וכתבתי "מדינת היהודים".', answer: 'הרצל', opts: ['הרצל', 'בן גוריון', 'ויצמן', 'ז\'בוטינסקי'], correct: 0 },
  { clue: 'אני גיבורת פורים. הצלתי את עם ישראל מהמן הרשע.', answer: 'אסתר המלכה', opts: ['רות', 'דבורה', 'אסתר המלכה', 'מרים'], correct: 2 },
  { clue: 'אני שפטתי את ישראל מתחת לתמר. הנהגתי את ישראל למלחמה.', answer: 'דבורה הנביאה', opts: ['מרים', 'אסתר', 'דבורה הנביאה', 'רחל'], correct: 2 },
];

let whoAmITimer = null, whoAmIRound = 0, whoAmIActive = [];

function startWhoAmI() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'whoami'; whoAmIRound = 0;
  whoAmIActive = shuffle([...WHO_AM_I_Q]).slice(0, 8);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: whoAmIActive.length, topic: '', mode: 'whoami' });
  setTimeout(nextWhoAmIRound, 1500);
}

function nextWhoAmIRound() {
  if (gameState !== 'playing') return;
  if (whoAmIRound >= whoAmIActive.length) { endGame(); return; }
  const q = whoAmIActive[whoAmIRound]; whoAmIRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'whoAmIRound', round: whoAmIRound, total: whoAmIActive.length, clue: q.clue, opts: q.opts, timeLimit: 25 });
  clearTimeout(whoAmITimer);
  whoAmITimer = setTimeout(() => {
    const aq = whoAmIActive[whoAmIRound - 1];
    Object.values(players).filter(p => p._chosen === aq.correct).forEach(p => { p.score += 100; p.correct++; });
    broadcast({ type: 'reveal', correct: aq.correct, correctText: aq.answer, mode: 'whoami',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextWhoAmIRound, 4000);
  }, 25000);
}

function handleWhoAmIAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = whoAmIActive[whoAmIRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'whoami' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(whoAmITimer);
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.answer, mode: 'whoami',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextWhoAmIRound, 4000);
  }
}

// ===== BIBLE CHAIN (שרשרת תנ"ך) =====
const BIBLE_CHAIN = [
  { q: 'אדם הראשון — מאיזה חומר נוצר?', opts: ['עפר האדמה','מים','אש','רוח'], correct: 0, next: 'אדם הראשון' },
  { q: 'אדם הראשון — מה שמה של אשתו?', opts: ['שרה','חוה','רחל','לאה'], correct: 1, next: 'חוה' },
  { q: 'חוה — מה אכלה בגן עדן?', opts: ['תאנה','ענב','פרי עץ הדעת','רימון'], correct: 2, next: 'עץ הדעת' },
  { q: 'עץ הדעת — מה שם הנחש שפיתה את חוה?', opts: ['הנחש הנחושת','הנחש הקדמוני','השטן','לא ידוע שמו'], correct: 1, next: 'נח' },
  { q: 'נח — כמה בנים היו לו?', opts: ['2','3','4','5'], correct: 1, next: 'שם' },
  { q: 'שם — מי היה אביו?', opts: ['אברהם','נח','מתושלח','למך'], correct: 1, next: 'אברהם' },
  { q: 'אברהם — מה היה שמו לפני שנקרא אברהם?', opts: ['אברם','אבינדב','אביהוד','אברהל'], correct: 0, next: 'שרה' },
  { q: 'שרה — כמה שנים חיתה?', opts: ['100','127','120','90'], correct: 1, next: 'סוף' },
];

let bcTimer = null, bcRound = 0;

function startBibleChain() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'biblechain'; bcRound = 0;
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: BIBLE_CHAIN.length, topic: 'תנ"ך', mode: 'biblechain' });
  setTimeout(nextBCRound, 1500);
}

function nextBCRound() {
  if (gameState !== 'playing') return;
  if (bcRound >= BIBLE_CHAIN.length) { endGame(); return; }
  const q = BIBLE_CHAIN[bcRound]; bcRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  const chain = BIBLE_CHAIN.slice(0, bcRound).map(r => r.next).filter(Boolean);
  broadcast({ type: 'bcRound', round: bcRound, total: BIBLE_CHAIN.length, question: q.q, opts: q.opts, chain, timeLimit: 20 });
  clearTimeout(bcTimer);
  bcTimer = setTimeout(() => {
    Object.values(players).filter(p => p._chosen === q.correct).forEach(p => { p.score += 100; p.correct++; });
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.opts[q.correct], mode: 'biblechain',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextBCRound, 4000);
  }, 20000);
}

function handleBCAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = BIBLE_CHAIN[bcRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'biblechain' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(bcTimer);
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.opts[q.correct], mode: 'biblechain',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextBCRound, 4000);
  }
}

// Register new game routes
app.get('/start-guesssong', (req, res) => { startGuessSong(); res.send('ok'); });
app.get('/start-whoami',    (req, res) => { startWhoAmI();    res.send('ok'); });
app.get('/start-biblechain',(req, res) => { startBibleChain();res.send('ok'); });
app.get('/start-whofirst',  (req, res) => { startWhoFirst();  res.send('ok'); });
app.get('/start-spinwheel', (req, res) => { startSpinWheel(); res.send('ok'); });
app.get('/start-doubledown',(req, res) => { startDoubleDown(); res.send('ok'); });

// ===== הכפיל או הפסד (DOUBLE DOWN) =====
let ddTimer = null, ddRound = 0, ddQuestions = [];
// Per-player choice: 'safe' or 'double'
let ddChoices = {};

function startDoubleDown() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'doubledown'; ddRound = 0;
  const allQ = loadQuestions();
  ddQuestions = shuffle(allQ).slice(0, 10);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; p._ddMode = null; });
  broadcast({ type: 'gameStart', total: ddQuestions.length, topic: '', mode: 'doubledown' });
  setTimeout(nextDDRound, 1500);
}

function nextDDRound() {
  if (gameState !== 'playing') return;
  if (ddRound >= ddQuestions.length) { endGame(); return; }
  const q = ddQuestions[ddRound]; ddRound++;
  ddChoices = {};
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; p._ddMode = null; });
  broadcast({ type: 'ddRound', round: ddRound, total: ddQuestions.length,
    question: q.q, answers: q.a, topic: q.topic, timeLimit: 22 });
  clearTimeout(ddTimer);
  ddTimer = setTimeout(revealDD, 22000);
}

function revealDD() {
  clearTimeout(ddTimer);
  const q = ddQuestions[ddRound - 1];
  if (!q) return;
  // Score each player
  Object.values(players).forEach(p => {
    if (p._chosen === null || p._chosen === undefined) return;
    const isCorrect = p._chosen === q.correct;
    const isDouble = p._ddMode === 'double';
    if (isCorrect) {
      const pts = isDouble ? 200 : 100;
      p.score += pts; p.correct++;
      p._ddResult = { correct: true, pts, double: isDouble };
    } else {
      const penalty = isDouble ? -100 : 0;
      p.score = Math.max(0, p.score + penalty);
      p._ddResult = { correct: false, pts: penalty, double: isDouble };
    }
  });
  broadcast({ type: 'ddReveal', correct: q.correct, correctText: q.a[q.correct],
    players: Object.values(players).map(p => ({
      callId: p.callId, score: p.score, correct: p.correct,
      chosen: p._chosen, ddMode: p._ddMode, ddResult: p._ddResult
    }))
  });
  if (gameState === 'playing') setTimeout(nextDDRound, 5000);
}

function handleDDAnswer(player, digit) {
  // Phase 1: digits 1/2 = safe/double choice (before answering)
  // Phase 2: digits 1-4 = actual answer
  if (player._ddMode === null) {
    // First input: 1=safe, 2=double
    if (digit === 1) { player._ddMode = 'safe'; broadcast({ type: 'ddChoice', playerName: player.name, phone: player.phone, mode: 'safe' }); }
    else if (digit === 2) { player._ddMode = 'double'; broadcast({ type: 'ddChoice', playerName: player.name, phone: player.phone, mode: 'double' }); }
    return; // don't mark answered yet
  }
  // Second input: answer
  if (player.answered) return;
  player.answered = true;
  player._chosen = digit - 1;
  const q = ddQuestions[ddRound - 1];
  if (!q) return;
  const isCorrect = player._chosen === q.correct;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen: player._chosen, correct: isCorrect, mode: 'doubledown', ddMode: player._ddMode });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(ddTimer);
    revealDD();
  }
}

// ===== מי הראשון? (WHO CAME FIRST) =====
const WHO_FIRST_Q = [
  { q: 'מה קרה ראשון?', opts: ['חורבן בית ראשון','חורבן בית שני','יציאת מצרים','מתן תורה'], correct: 2, order: ['יציאת מצרים','מתן תורה','חורבן בית ראשון','חורבן בית שני'] },
  { q: 'מי נולד ראשון?', opts: ['שלמה המלך','דוד המלך','שאול המלך','שמואל הנביא'], correct: 3, order: ['שמואל הנביא','שאול המלך','דוד המלך','שלמה המלך'] },
  { q: 'מה קרה ראשון בתורה?', opts: ['עשרת הדיברות','עקידת יצחק','ברית מילה לאברהם','נח ותיבה'], correct: 3, order: ['נח ותיבה','ברית מילה לאברהם','עקידת יצחק','עשרת הדיברות'] },
  { q: 'מי חי ראשון?', opts: ['הרמב\"ם','רש\"י','ר\' יוסף קארו','הבעש\"ט'], correct: 1, order: ['רש\"י','הרמב\"ם','ר\' יוסף קארו','הבעש\"ט'] },
  { q: 'מה קרה ראשון בתולדות ישראל?', opts: ['כיבוש ירושלים','מלחמת ששת הימים','הכרזת מדינה','מלחמת יום כיפור'], correct: 2, order: ['הכרזת מדינה','כיבוש ירושלים','מלחמת יום כיפור','מלחמת ששת הימים'] },
  { q: 'מה בא ראשון בסדר הפסח?', opts: ['מגיד','קדש','כרפס','יחץ'], correct: 1, order: ['קדש','כרפס','יחץ','מגיד'] },
  { q: 'מי קדם לשני?', opts: ['אברהם','נח','משה','יהושע'], correct: 1, order: ['נח','אברהם','משה','יהושע'] },
  { q: 'מה נכתב ראשון?', opts: ['משנה','תלמוד בבלי','תנ\"ך','שולחן ערוך'], correct: 2, order: ['תנ\"ך','משנה','תלמוד בבלי','שולחן ערוך'] },
  { q: 'איזו מכה הייתה ראשונה?', opts: ['צפרדע','דם','כינים','ערוב'], correct: 1, order: ['דם','צפרדע','כינים','ערוב'] },
  { q: 'מה היה ראשון?', opts: ['מדינת ישראל','שואה','עלייה ראשונה','בלפור'], correct: 2, order: ['עלייה ראשונה','בלפור','שואה','מדינת ישראל'] },
];

let wfTimer = null, wfRound = 0, wfActive = [];

function startWhoFirst() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'whofirst'; wfRound = 0;
  wfActive = shuffle([...WHO_FIRST_Q]).slice(0, 8);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: wfActive.length, topic: 'כרונולוגיה', mode: 'whofirst' });
  setTimeout(nextWFRound, 1500);
}

function nextWFRound() {
  if (gameState !== 'playing') return;
  if (wfRound >= wfActive.length) { endGame(); return; }
  const q = wfActive[wfRound]; wfRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'wfRound', round: wfRound, total: wfActive.length, question: q.q, opts: q.opts, order: q.order, timeLimit: 18 });
  clearTimeout(wfTimer);
  wfTimer = setTimeout(() => {
    const aq = wfActive[wfRound - 1];
    Object.values(players).filter(p => p._chosen === aq.correct).forEach(p => { p.score += 100; p.correct++; });
    broadcast({ type: 'reveal', correct: aq.correct, correctText: aq.opts[aq.correct], order: aq.order, mode: 'whofirst',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextWFRound, 5000);
  }, 18000);
}

function handleWFAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = wfActive[wfRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'whofirst' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(wfTimer);
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.opts[q.correct], order: q.order, mode: 'whofirst',
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct })) });
    if (gameState === 'playing') setTimeout(nextWFRound, 5000);
  }
}

// ===== גלגל המזל (SPIN WHEEL) =====
const SW_CATEGORIES = ['תורה','חגים','יהדות','היסטוריה','ארצות','ידע כללי','ספורט','מדע'];
let swTimer = null, swRound = 0, swQuestions = [], swPlayerCats = {};

function startSpinWheel() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'spinwheel'; swRound = 0;
  const allQ = loadQuestions();
  swQuestions = [];
  // Build 10 rounds — each round every player gets a random category
  for (let i = 0; i < 10; i++) {
    const roundCats = {};
    Object.keys(players).forEach(cid => {
      const cat = SW_CATEGORIES[Math.floor(Math.random() * SW_CATEGORIES.length)];
      const catQ = allQ.filter(q => q.topic === cat);
      const q = catQ[Math.floor(Math.random() * catQ.length)];
      roundCats[cid] = { cat, q };
    });
    swQuestions.push(roundCats);
  }
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: 10, topic: 'גלגל', mode: 'spinwheel' });
  setTimeout(nextSWRound, 1500);
}

function nextSWRound() {
  if (gameState !== 'playing') return;
  if (swRound >= 10 || swRound >= swQuestions.length) { endGame(); return; }
  const roundData = swQuestions[swRound]; swRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  // Send each player their own question
  const playerRounds = {};
  Object.entries(roundData).forEach(([cid, {cat, q}]) => {
    if (!q) return;
    playerRounds[cid] = { cat, question: q.q, answers: q.a, correct: q.correct };
  });
  broadcast({ type: 'swRound', round: swRound, total: 10, playerRounds, timeLimit: 20 });
  clearTimeout(swTimer);
  swTimer = setTimeout(() => {
    // Score each player on their own question
    Object.entries(roundData).forEach(([cid, {q}]) => {
      const p = players[cid];
      if (!p || !q) return;
      if (p._chosen === q.correct) { p.score += 150; p.correct++; }
      else if (p._chosen !== null && p._chosen !== undefined) { p.score = Math.max(0, p.score - 30); }
    });
    broadcast({ type: 'swReveal', round: swRound, playerRounds,
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })) });
    if (gameState === 'playing') setTimeout(nextSWRound, 5000);
  }, 20000);
}

function handleSWAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const roundData = swQuestions[swRound - 1];
  if (!roundData || !roundData[player.callId]) return;
  const { q } = roundData[player.callId];
  const isCorrect = q && chosen === q.correct;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'spinwheel' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(swTimer);
    Object.entries(roundData).forEach(([cid, {q}]) => {
      const p = players[cid];
      if (!p || !q) return;
      if (p._chosen === q.correct) { p.score += 150; p.correct++; }
      else if (p._chosen !== null) { p.score = Math.max(0, p.score - 30); }
    });
    broadcast({ type: 'swReveal', round: swRound, playerRounds: Object.fromEntries(
      Object.entries(roundData).map(([cid,{cat,q}]) => [cid, {cat, question: q?.q, answers: q?.a, correct: q?.correct}])
    ), players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })) });
    if (gameState === 'playing') setTimeout(nextSWRound, 5000);
  }
}



// ===== פלאשבק (FLASHBACK) — ניחוש עשור =====
const FLASHBACK_Q = [
  { q: 'באיזה עשור הוקמה מדינת ישראל?', opts: ['שנות ה-30','שנות ה-40','שנות ה-50','שנות ה-60'], correct: 1, year: 1948 },
  { q: 'באיזה עשור התקיימה מלחמת ששת הימים?', opts: ['שנות ה-50','שנות ה-60','שנות ה-70','שנות ה-80'], correct: 1, year: 1967 },
  { q: 'באיזה עשור קרתה מלחמת יום כיפור?', opts: ['שנות ה-60','שנות ה-70','שנות ה-80','שנות ה-90'], correct: 1, year: 1973 },
  { q: 'באיזה עשור ישראל חתמה על שלום עם מצרים?', opts: ['שנות ה-60','שנות ה-70','שנות ה-80','שנות ה-90'], correct: 1, year: 1979 },
  { q: 'באיזה עשור חזרה לאוויר תחנת הטלוויזיה הראשונה בישראל?', opts: ['שנות ה-60','שנות ה-70','שנות ה-80','שנות ה-90'], correct: 0, year: 1968 },
  { q: 'באיזה עשור נפל חומת ברלין?', opts: ['שנות ה-70','שנות ה-80','שנות ה-90','שנות ה-2000'], correct: 1, year: 1989 },
  { q: 'באיזה עשור עלה האינטרנט לאוויר העולם?', opts: ['שנות ה-70','שנות ה-80','שנות ה-90','שנות ה-2000'], correct: 1, year: 1991 },
  { q: 'באיזה עשור ביצע סדאם חוסיין פלישה לכווית?', opts: ['שנות ה-70','שנות ה-80','שנות ה-90','שנות ה-2000'], correct: 2, year: 1990 },
  { q: 'באיזה עשור קרה פיגוע אחד עשר בספטמבר?', opts: ['שנות ה-90','שנות ה-2000','שנות ה-2010','שנות ה-2020'], correct: 1, year: 2001 },
  { q: 'באיזה עשור ישראל זכתה לראשונה באירוויזיון?', opts: ['שנות ה-60','שנות ה-70','שנות ה-80','שנות ה-90'], correct: 1, year: 1978 },
];

let fbTimer = null, fbRound = 0;

function startFlashback() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'flashback'; fbRound = 0;
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: FLASHBACK_Q.length, topic: 'היסטוריה', mode: 'flashback' });
  setTimeout(nextFBRound, 1500);
}

function nextFBRound() {
  if (gameState !== 'playing') return;
  if (fbRound >= FLASHBACK_Q.length) { endGame(); return; }
  const q = FLASHBACK_Q[fbRound]; fbRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'question', question: q.q, answers: q.opts, topic: 'פלאשבק', index: fbRound, total: FLASHBACK_Q.length, timeLimit: 18, mode: 'flashback' });
  clearTimeout(fbTimer);
  fbTimer = setTimeout(() => {
    const q2 = FLASHBACK_Q[fbRound - 1];
    Object.values(players).forEach(p => {
      if (p._chosen === null) return;
      if (p._chosen === q2.correct) { p.score += 100; p.correct++; }
    });
    broadcast({ type: 'reveal', correct: q2.correct, correctText: q2.opts[q2.correct], year: q2.year,
      mode: 'flashback', players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })) });
    if (gameState === 'playing') setTimeout(nextFBRound, 5000);
  }, 18000);
}

function handleFBAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = FLASHBACK_Q[fbRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'flashback' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(fbTimer);
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.opts[q.correct], year: q.year,
      mode: 'flashback', players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })) });
    if (gameState === 'playing') setTimeout(nextFBRound, 5000);
  }
}

app.get('/start-flashback', (req, res) => { startFlashback(); res.send('ok'); });

// ===== מסירת הפתק (PASSNOTE) — בליץ קבוצתי =====
let passTimer = null, passRound = 0, passQuestions = [];

function startPassNote() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'passnote'; passRound = 0;
  const allQ = loadQuestions();
  const unasked = getUnaskedQuestions(allQ);
  passQuestions = shuffle(unasked).slice(0, 15);
  markQuestionsAsked(passQuestions);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: passQuestions.length, topic: 'כל הנושאים', mode: 'passnote' });
  setTimeout(nextPassRound, 1500);
}

function nextPassRound() {
  if (gameState !== 'playing') return;
  if (passRound >= passQuestions.length) { endGame(); return; }
  const q = passQuestions[passRound]; passRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'question', question: q.q, answers: q.a, topic: q.topic,
    index: passRound, total: passQuestions.length, timeLimit: 8, mode: 'passnote' });
  clearTimeout(passTimer);
  passTimer = setTimeout(() => {
    Object.values(players).forEach(p => {
      if (p._chosen === q.correct) { p.score += 80; p.correct++; }
    });
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.a[q.correct],
      players: Object.values(players).map(p => ({ callId: p.callId, name: p.name, score: p.score, correct: p.correct, chosen: p._chosen, color: p.color })),
      mode: 'passnote' });
    if (gameState === 'playing') setTimeout(nextPassRound, 3000);
  }, 8000);
}

function handlePassNoteAnswer(player, chosen) {
  if (player.answered) return;
  const q = passQuestions[passRound - 1];
  if (!q) return;
  player.answered = true;
  player._chosen = chosen;
  const isCorrect = chosen === q.correct;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'passnote' });
  log('📝', `${player.name} → ${isCorrect ? 'נכון' : 'שגוי'}`);
  // אם כולם ענו — חשוף מיד
  const all = Object.values(players).every(p => p.answered);
  if (all) {
    clearTimeout(passTimer);
    broadcast({ type: 'allAnswered' });
    // חשב ניקוד וחשוף
    Object.values(players).forEach(p => { if (p._chosen === q.correct) { p.score += 80; p.correct++; } });
    broadcast({ type: 'reveal', correct: q.correct, correctText: q.a[q.correct],
      players: Object.values(players).map(p => ({ callId: p.callId, name: p.name, score: p.score, correct: p.correct, chosen: p._chosen, color: p.color })),
      mode: 'passnote' });
    if (gameState === 'playing') passTimer = setTimeout(nextPassRound, 2500);
  }
}

app.get('/start-passnote', (req, res) => { startPassNote(); res.send('ok'); });

// ===== פענוח תמונה (PICTURE DECODE) — ניחוש מתיאור =====
const PICTURE_QUESTIONS = [
  { desc: 'תמונה: שני ילדים ומטאטא עצום, שלג עמוק, אף גזר, לבוש שחור, כפתורים, צעיף פסים', opts: ['איש שלג','בובת עץ','פחדית','מסכה'], correct: 0, reveal: '☃️ איש שלג קלאסי!' },
  { desc: 'תמונה: כיפה מוזהבת, אבן לבנה גדולה, ירושלים, מוסלמים מתפללים', opts: ['כיפת הסלע','מסגד אל-אקצא','הר הבית','הכותל המערבי'], correct: 0, reveal: '🕌 כיפת הסלע — ירושלים' },
  { desc: 'תמונה: חמישה טבעות צבעוניות קשורות, רקע לבן, שחור, אדום, צהוב, ירוק, כחול', opts: ['אולימפיאדה','מופע צירקוס','דגל האו"ם','ספר ילדים'], correct: 0, reveal: '🏅 סמל האולימפיאדה' },
  { desc: 'תמונה: ספר עם עטיפה כחולה ואדומה, ילד עם משקפיים, צלקת ברק על המצח', opts: ['הארי פוטר','פרסי ג\'קסון','הוביט','ילד הנבואה'], correct: 0, reveal: '⚡ הארי פוטר — ויזארד האגדה' },
  { desc: 'תמונה: שולחן ארוך, עשרה אנשים, לחם ויין, אחד בורח', opts: ['הסעודה האחרונה','פסח','שבת','ברית מילה'], correct: 0, reveal: '✝️ הסעודה האחרונה של ישו' },
  { desc: 'תמונה: ים כחול, בדאי עם מגל ולבוש לבן, ספינה ישנה, פסל בים', opts: ['פסל החירות','פסל הדייג','פסל הפוסידון','פוסידון אתונה'], correct: 0, reveal: '🗽 פסל החירות בניו יורק' },
  { desc: 'תמונה: ענן אטומי גדול, עיר יפנית, פטרייה ענקית עולה לשמיים, שנת 1945', opts: ['פצצה גרעינית','הר געש','סופת ברד','פיצוץ מפעל'], correct: 0, reveal: '💥 פיצוץ הפצצה האטומית בהירושימה' },
  { desc: 'תמונה: ילד כחול, פיל גדול אפור, ג\'ונגל, חבורת קופים, נחש ענק', opts: ['ספר הג\'ונגל','טרזן','פיל דאמבו','ראנגלי'], correct: 0, reveal: '🐍 ספר הג\'ונגל — מוגלי' },
  { desc: 'תמונה: שורות ענק של כוורות, ממד אנשים, חלוק לבן, מסכה, עישון', opts: ['גידול דבורים','ניתוח','צילום סרט','מעבדת כימייה'], correct: 0, reveal: '🐝 גידול דבורים — כוורן' },
  { desc: 'תמונה: ילד קטן, חצר בית, כדור כסף גדול, הרבה כוכבים ציורים', opts: ['נסיך קטן','אסטרונאוט','בובת חייזר','הבובה הקסומה'], correct: 0, reveal: '⭐ הנסיך הקטן' },
  { desc: 'תמונה: בניין לבן ענק, כיפה גדולה, שני בתים גבוהים בצדדים, ירוק מסביב', opts: ['בית הלבן','קפיטול','פרלמנט','נשיאות צרפת'], correct: 0, reveal: '🏛️ הבית הלבן בוושינגטון' },
  { desc: 'תמונה: ממתק ארוך, פסים לבנים ואדומים, בצורת ווו, מיני', opts: ['מקל סוכריות','שוקולד מקל','גלידה במקל','עוגיית וניל'], correct: 0, reveal: '🍬 מקל הסוכריות של חג המולד' },
  { desc: 'תמונה: שני שחקנים, משחק לוח, 64 ריבועים, כלים עם כתרים ועוד', opts: ['שחמט','שש-בש','דמקה','מונופולי'], correct: 0, reveal: '♟️ שחמט — משחק הלוח הקלאסי' },
  { desc: 'תמונה: עלה עם שבע אצבעות, ירוק כהה, עגול מאוד, פרח צהוב בצד', opts: ['עלה קנאביס','עלה אשור','עלה תפוח','עלה ענב'], correct: 0, reveal: '🍃 עלה קנאביס' },
  { desc: 'תמונה: ייצור קטן, כחול, אוזניים ארוכות, שלוש כפתורים, שמח', opts: ['סטיץ','דוריאן','מינייון','גרוביט'], correct: 0, reveal: '💙 סטיץ — הייצור הכחול של דיסני' },
  { desc: 'תמונה: אצטדיון ענק, ריצה 100 מטר, ספורטאי מרים ידיים, בוסאיין בולט', opts: ['אולימפיאדת בייג\'ינג','אולימפיאדת לונדון','מונדיאל','גרנד פרי'], correct: 1, reveal: '🏃 אולימפיאדת לונדון 2012 — אוסיין בולט' },
  { desc: 'תמונה: עגבניות, גבינה לבנה, בצל, שום, ירוקים, בלילת שמן זית', opts: ['שקשוקה','פיצה','פסטה','פלאפל'], correct: 0, reveal: '🍳 שקשוקה ישראלית קלאסית!' },
  { desc: 'תמונה: ים כינרת, ידיים על המים, שחפים, סירת דייגים עתיקה', opts: ['כינרת','ים המלח','ים סוף','נהר הירדן'], correct: 0, reveal: '🌊 כינרת — ים הגליל' },
];

let picTimer = null, picRound = 0, picQuestions = [];

function startPictureGame() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'picture'; picRound = 0;
  picQuestions = shuffle([...PICTURE_QUESTIONS]).slice(0, 10);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; });
  broadcast({ type: 'gameStart', total: picQuestions.length, topic: 'פענוח תמונה', mode: 'picture' });
  setTimeout(nextPicRound, 1500);
}

function nextPicRound() {
  if (gameState !== 'playing') return;
  if (picRound >= picQuestions.length) { endGame(); return; }
  const q = picQuestions[picRound]; picRound++;
  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({ type: 'picRound', round: picRound, total: picQuestions.length, desc: q.desc, opts: q.opts, timeLimit: 20, mode: 'picture' });
  clearTimeout(picTimer);
  picTimer = setTimeout(() => {
    const q2 = picQuestions[picRound - 1];
    Object.values(players).forEach(p => {
      if (p._chosen === q2.correct) { p.score += 100; p.correct++; }
    });
    broadcast({ type: 'picReveal', correct: q2.correct, correctText: q2.opts[q2.correct], reveal: q2.reveal,
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })), mode: 'picture' });
    if (gameState === 'playing') setTimeout(nextPicRound, 5000);
  }, 20000);
}

function handlePicAnswer(player, chosen) {
  if (player.answered) return;
  player.answered = true; player._chosen = chosen;
  const q = picQuestions[picRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  if (isCorrect) { player.score += 100; player.correct++; }
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'picture' });
  if (Object.values(players).every(p => p.answered)) {
    clearTimeout(picTimer);
    broadcast({ type: 'picReveal', correct: q.correct, correctText: q.opts[q.correct], reveal: q.reveal,
      players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen })), mode: 'picture' });
    if (gameState === 'playing') setTimeout(nextPicRound, 5000);
  }
}

app.get('/start-picture', (req, res) => { startPictureGame(); res.send('ok'); });

// ===== פירמידה (PYRAMID) — שאלות קשות ויותר, ניקוד עולה, טעות חוצה ניקוד =====
let pyramidTimer = null, pyramidRound = 0, pyramidQuestions = [];

// Point values per level: 50, 100, 150, 200, 300, 400, 500, 750, 1000, JACKPOT 2000
const PYRAMID_PTS = [50, 100, 150, 200, 300, 400, 500, 750, 1000, 2000];
const PYRAMID_LABELS = ['שלב 1','שלב 2','שלב 3','שלב 4','שלב 5','שלב 6','שלב 7','שלב 8','שלב 9','🏆 ג\'קפוט!'];
const PYRAMID_TIME  = [22, 22, 20, 20, 18, 18, 15, 15, 12, 10]; // shrinks as pyramid climbs

function startPyramid() {
  stopAllTimers();
  gameState = 'playing'; gameMode = 'pyramid'; pyramidRound = 0;
  const allQ = loadQuestions();
  const unasked = getUnaskedQuestions(allQ);
  // Sort by topic length as a rough proxy, then shuffle within blocks for variety
  pyramidQuestions = shuffle(unasked).slice(0, 10);
  markQuestionsAsked(pyramidQuestions);
  Object.values(players).forEach(p => { p.score = 0; p.correct = 0; p.answered = false; p._chosen = null; p._eliminated = false; });
  broadcast({ type: 'gameStart', total: pyramidQuestions.length, topic: 'פירמידה', mode: 'pyramid' });
  setTimeout(nextPyramidRound, 1500);
}

function nextPyramidRound() {
  if (gameState !== 'playing') return;
  if (pyramidRound >= pyramidQuestions.length) { endGame(); return; }
  // Check if everyone was eliminated
  const alive = Object.values(players).filter(p => !p._eliminated);
  if (alive.length === 0 && Object.keys(players).length > 0) { endGame(); return; }

  const q = pyramidQuestions[pyramidRound];
  const pts = PYRAMID_PTS[pyramidRound];
  const label = PYRAMID_LABELS[pyramidRound];
  const timeLimit = PYRAMID_TIME[pyramidRound];
  pyramidRound++;

  Object.values(players).forEach(p => { p.answered = false; p._chosen = null; });
  broadcast({
    type: 'pyramidRound', round: pyramidRound, total: pyramidQuestions.length,
    question: q.q, answers: q.a, topic: q.topic,
    pts, label, timeLimit, mode: 'pyramid',
    playerScores: Object.values(players).map(p => ({ callId: p.callId, score: p.score, eliminated: p._eliminated }))
  });
  clearTimeout(pyramidTimer);
  pyramidTimer = setTimeout(() => revealPyramid(), timeLimit * 1000);
}

function revealPyramid() {
  clearTimeout(pyramidTimer);
  const q = pyramidQuestions[pyramidRound - 1];
  const pts = PYRAMID_PTS[pyramidRound - 1];
  Object.values(players).forEach(p => {
    if (p._eliminated) return;
    if (p._chosen === q.correct) {
      p.score += pts; p.correct++;
    } else {
      // Wrong or no answer: halve the score (floor)
      p.score = Math.floor(p.score / 2);
      if (pyramidRound >= 5) p._eliminated = true; // eliminate from round 5 onwards
    }
  });
  broadcast({
    type: 'pyramidReveal', round: pyramidRound, correct: q.correct, correctText: q.a[q.correct],
    pts, mode: 'pyramid',
    players: Object.values(players).map(p => ({ callId: p.callId, score: p.score, correct: p.correct, chosen: p._chosen, eliminated: p._eliminated }))
  });
  if (gameState === 'playing') setTimeout(nextPyramidRound, 5000);
}

function handlePyramidAnswer(player, chosen) {
  if (player.answered || player._eliminated) return;
  player.answered = true; player._chosen = chosen;
  const q = pyramidQuestions[pyramidRound - 1];
  if (!q) return;
  const isCorrect = chosen === q.correct;
  broadcast({ type: 'answer', playerName: player.name, phone: player.phone, chosen, correct: isCorrect, mode: 'pyramid' });
  const active = Object.values(players).filter(p => !p._eliminated);
  if (active.every(p => p.answered)) {
    clearTimeout(pyramidTimer);
    revealPyramid();
  }
}

app.get('/start-pyramid', (req, res) => { startPyramid(); res.send('ok'); });

// Resend the current round to a reconnected/confused client
app.get('/resend-round', (req, res) => {
  if (gameState !== 'playing') { res.json({ ok: false }); return; }
  if (gameMode === 'pyramid' && pyramidRound > 0 && pyramidQuestions[pyramidRound-1]) {
    const q = pyramidQuestions[pyramidRound-1];
    res.json({ ok: true, msg: {
      type: 'pyramidRound', round: pyramidRound, total: pyramidQuestions.length,
      question: q.q, answers: q.a, topic: q.topic,
      pts: PYRAMID_PTS[pyramidRound-1], label: PYRAMID_LABELS[pyramidRound-1],
      timeLimit: PYRAMID_TIME[pyramidRound-1], mode: 'pyramid',
      playerScores: Object.values(players).map(p => ({ callId: p.callId, score: p.score, eliminated: p._eliminated }))
    }});
  } else if (gameMode === 'passnote' && passRound > 0 && passQuestions[passRound-1]) {
    const q = passQuestions[passRound-1];
    res.json({ ok: true, msg: { type: 'question', question: q.q, answers: q.a, index: passRound, total: passQuestions.length, timeLimit: 8, mode: 'passnote' }});
  } else {
    res.json({ ok: false });
  }
});
