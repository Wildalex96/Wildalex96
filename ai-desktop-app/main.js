const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(app.getPath('userData'), 'localmind');
const memoryFile = path.join(dataDir, 'memory.json');
const settingsFile = path.join(dataDir, 'settings.json');

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, JSON.stringify({ memories: [] }, null, 2));
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' }, null, 2));
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function getSettings() { return readJson(settingsFile, { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' }); }
function getMemory() { return readJson(memoryFile, { memories: [] }); }

async function ollama(messages) {
  const s = getSettings();
  const r = await fetch(`${s.endpoint.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.model, messages, stream: false })
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.message?.content || '';
}

async function learnFromConversation(user, assistant) {
  const prompt = `Extract only durable user-specific facts, preferences, goals, or instructions from this exchange. Return JSON array of short strings. If none, return []. Do not infer sensitive traits.\nUSER: ${user}\nASSISTANT: ${assistant}`;
  try {
    const raw = await ollama([{ role: 'system', content: 'You are a memory extractor. Output JSON only.' }, { role: 'user', content: prompt }]);
    const clean = raw.replace(/```json|```/g, '').trim();
    const items = JSON.parse(clean);
    if (Array.isArray(items)) {
      const db = getMemory();
      for (const item of items.slice(0, 5)) {
        const text = String(item).trim();
        if (text && !db.memories.includes(text)) db.memories.push(text);
      }
      db.memories = db.memories.slice(-5000);
      writeJson(memoryFile, db);
    }
  } catch (_) {}
}

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_, value) => {
  const next = { endpoint: String(value.endpoint || '').trim(), model: String(value.model || '').trim() };
  writeJson(settingsFile, next); return next;
});
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
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
