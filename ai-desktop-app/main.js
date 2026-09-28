const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const https = require('https');

const dataDir = path.join(app.getPath('userData'), 'localmind');
const memoryFile = path.join(dataDir, 'memory.json');
const settingsFile = path.join(dataDir, 'settings.json');
const bootstrapFile = path.join(dataDir, 'bootstrap.json');
const DEFAULT_MODEL = 'qwen3:4b';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_EXE = path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe');

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, JSON.stringify({ memories: [] }, null, 2));
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ endpoint: OLLAMA_URL, model: DEFAULT_MODEL }, null, 2));
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function getSettings() { return readJson(settingsFile, { endpoint: OLLAMA_URL, model: DEFAULT_MODEL }); }
function getMemory() { return readJson(memoryFile, { memories: [] }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ollamaInstalled() { return fs.existsSync(OLLAMA_EXE); }
function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(); fs.unlink(destination, () => {});
        return downloadFile(response.headers.location, destination).then(resolve, reject);
      }
      if (response.statusCode !== 200) { file.close(); fs.unlink(destination, () => {}); return reject(new Error(`Download HTTP ${response.statusCode}`)); }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { file.close(); fs.unlink(destination, () => {}); reject(err); });
  });
}
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${exe} exited ${code}: ${stderr || stdout}`)));
  });
}

async function waitForOllama(timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const r = await fetch(`${OLLAMA_URL}/api/tags`); if (r.ok) return true; } catch (_) {}
    await sleep(1500);
  }
  return false;
}

async function ensureOllamaAndModel(sendStatus) {
  ensureData();
  let settings = getSettings();
  if (settings.endpoint !== OLLAMA_URL || settings.model !== DEFAULT_MODEL) {
    settings = { endpoint: OLLAMA_URL, model: DEFAULT_MODEL };
    writeJson(settingsFile, settings);
  }
  try {
    if (!ollamaInstalled()) {
      sendStatus?.('Устанавливаю локальный AI-движок Ollama…');
      const installer = path.join(dataDir, 'OllamaSetup.exe');
      await downloadFile('https://ollama.com/download/OllamaSetup.exe', installer);
      await run(installer, ['/VERYSILENT', '/NORESTART']);
      try { fs.unlinkSync(installer); } catch (_) {}
    }
    sendStatus?.('Запускаю локальный AI-движок…');
    const proc = spawn(OLLAMA_EXE, ['serve'], { windowsHide: true, detached: true, stdio: 'ignore' });
    proc.unref();
    if (!await waitForOllama()) throw new Error('Ollama не запустился.');
    const tags = await (await fetch(`${OLLAMA_URL}/api/tags`)).json();
    const exists = (tags.models || []).some(m => m.name === DEFAULT_MODEL || m.name?.split(':')[0] === DEFAULT_MODEL.split(':')[0]);
    if (!exists) {
      sendStatus?.(`Скачиваю AI-модель ${DEFAULT_MODEL} (это может занять несколько минут)…`);
      await run(OLLAMA_EXE, ['pull', DEFAULT_MODEL]);
    }
    writeJson(bootstrapFile, { ready: true, model: DEFAULT_MODEL, completedAt: new Date().toISOString() });
    sendStatus?.('Готово. LocalMind работает полностью локально.');
    return true;
  } catch (error) {
    writeJson(bootstrapFile, { ready: false, error: error.message, updatedAt: new Date().toISOString() });
    sendStatus?.(`Не удалось автоматически подготовить AI: ${error.message}`);
    return false;
  }
}

async function ollama(messages) {
  const s = getSettings();
  const r = await fetch(`${s.endpoint.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: s.model, messages, stream: false }) });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.message?.content || '';
}

async function learnFromConversation(user, assistant) {
  const prompt = `Extract only durable user-specific facts, preferences, goals, or instructions from this exchange. Return JSON array of short strings. If none, return []. Do not infer sensitive traits.\nUSER: ${user}\nASSISTANT: ${assistant}`;
  try {
    const raw = await ollama([{ role: 'system', content: 'You are a memory extractor. Output JSON only.' }, { role: 'user', content: prompt }]);
    const items = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(items)) {
      const db = getMemory();
      for (const item of items.slice(0, 5)) { const text = String(item).trim(); if (text && !db.memories.includes(text)) db.memories.push(text); }
      db.memories = db.memories.slice(-5000); writeJson(memoryFile, db);
    }
  } catch (_) {}
}

ipcMain.handle('bootstrap:status', () => readJson(bootstrapFile, { ready: false }));
ipcMain.handle('bootstrap:start', async (event) => ensureOllamaAndModel(msg => event.sender.send('bootstrap:progress', msg)));
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_, value) => { const next = { endpoint: OLLAMA_URL, model: DEFAULT_MODEL }; writeJson(settingsFile, next); return next; });
ipcMain.handle('memory:get', () => getMemory().memories);
ipcMain.handle('memory:clear', () => { writeJson(memoryFile, { memories: [] }); return []; });
ipcMain.handle('chat', async (_, payload) => {
  const memory = getMemory().memories.slice(-100).join('\n- ');
  const system = `You are LocalMind, a private desktop AI assistant. Be helpful and honest. You have persistent memory below. Use it only when relevant.\n\nMEMORY:\n- ${memory || '(empty)'}`;
  const answer = await ollama([{ role: 'system', content: system }, ...(payload.history || []), { role: 'user', content: payload.message }]);
  learnFromConversation(payload.message, answer);
  return answer;
});
ipcMain.handle('test', async () => { await ollama([{ role: 'user', content: 'Reply with OK.' }]); return true; });

function createWindow() {
  ensureData();
  const win = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 650, backgroundColor: '#101318', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', () => { ensureOllamaAndModel(msg => win.webContents.send('bootstrap:progress', msg)).catch(() => {}); });
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
