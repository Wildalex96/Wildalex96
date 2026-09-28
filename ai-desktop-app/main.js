const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');

const dataDir = path.join(app.getPath('userData'), 'localmind');
const memoryFile = path.join(dataDir, 'memory.json');
const settingsFile = path.join(dataDir, 'settings.json');
const bootstrapFile = path.join(dataDir, 'bootstrap.json');
const webCacheFile = path.join(dataDir, 'web-cache.json');
const DEFAULT_MODEL = 'qwen3:4b';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_EXE = path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe');

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, JSON.stringify({ memories: [] }, null, 2));
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ endpoint: OLLAMA_URL, model: DEFAULT_MODEL, internet: true, autoLearn: true }, null, 2));
  if (!fs.existsSync(webCacheFile)) fs.writeFileSync(webCacheFile, JSON.stringify({ pages: [] }, null, 2));
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function getSettings() { return readJson(settingsFile, { endpoint: OLLAMA_URL, model: DEFAULT_MODEL, internet: true, autoLearn: true }); }
function getMemory() { return readJson(memoryFile, { memories: [] }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function downloadFile(url, destination) { return new Promise((resolve, reject) => { const file=fs.createWriteStream(destination); https.get(url, response => { if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){file.close();fs.unlink(destination,()=>{});return downloadFile(response.headers.location,destination).then(resolve,reject);} if(response.statusCode!==200){file.close();fs.unlink(destination,()=>{});return reject(new Error(`Download HTTP ${response.statusCode}`));} response.pipe(file);file.on('finish',()=>file.close(resolve)); }).on('error',err=>{file.close();fs.unlink(destination,()=>{});reject(err);}); }); }
function run(exe,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(exe,args,{windowsHide:true,...options});let stdout='',stderr='';child.stdout?.on('data',d=>stdout+=d);child.stderr?.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`${exe} exited ${code}: ${stderr||stdout}`)));});}
function ollamaInstalled(){return fs.existsSync(OLLAMA_EXE);}
async function waitForOllama(timeout=120000){const t=Date.now();while(Date.now()-t<timeout){try{const r=await fetch(`${OLLAMA_URL}/api/tags`);if(r.ok)return true;}catch{}await sleep(1500);}return false;}
async function ensureOllamaAndModel(sendStatus){ensureData();try{if(!ollamaInstalled()){sendStatus?.('Устанавливаю локальный AI-движок Ollama…');const installer=path.join(dataDir,'OllamaSetup.exe');await downloadFile('https://ollama.com/download/OllamaSetup.exe',installer);await run(installer,['/VERYSILENT','/NORESTART']);try{fs.unlinkSync(installer);}catch{}}sendStatus?.('Запускаю локальный AI-движок…');const p=spawn(OLLAMA_EXE,['serve'],{windowsHide:true,detached:true,stdio:'ignore'});p.unref();if(!await waitForOllama())throw new Error('Ollama не запустился.');const tags=await(await fetch(`${OLLAMA_URL}/api/tags`)).json();if(!(tags.models||[]).some(m=>m.name===DEFAULT_MODEL)){sendStatus?.(`Скачиваю модель ${DEFAULT_MODEL}…`);await run(OLLAMA_EXE,['pull',DEFAULT_MODEL]);}writeJson(bootstrapFile,{ready:true,model:DEFAULT_MODEL,completedAt:new Date().toISOString()});sendStatus?.('ИИ готов. Интернет-поиск включён.');return true;}catch(e){writeJson(bootstrapFile,{ready:false,error:e.message});sendStatus?.(`Ошибка подготовки ИИ: ${e.message}`);return false;}}
async function ollama(messages){const s=getSettings();const r=await fetch(`${s.endpoint.replace(/\/$/,'')}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:s.model,messages,stream:false})});if(!r.ok)throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`);return (await r.json()).message?.content||'';}
function fetchText(url,timeout=15000){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'LocalMind/1.0'}},r=>{if(r.statusCode>=300&&r.statusCode<400&&r.headers.location)return fetchText(r.headers.location,timeout).then(resolve,reject);if(r.statusCode!==200)return reject(new Error(`HTTP ${r.statusCode}`));let d='';r.setEncoding('utf8');r.on('data',c=>{d+=c;if(d.length>800000)r.destroy();});r.on('end',()=>resolve(d));});req.setTimeout(timeout,()=>{req.destroy(new Error('timeout'));});req.on('error',reject);});}
function stripHtml(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();}
async function webSearch(query){const url=`https://www.google.com/search?q=${encodeURIComponent(query)}`;const html=await fetchText(url);const text=stripHtml(html);return text.slice(0,12000);}
async function learnFromConversation(user,assistant,source='conversation'){const prompt=`Extract only durable, non-sensitive user preferences, goals, project facts, or explicit instructions from this material. Return JSON array of short strings. Do not infer sensitive traits. SOURCE:${source}\nTEXT:${user}\nANSWER:${assistant}`;try{const raw=await ollama([{role:'system',content:'You are a memory curator. JSON only.'},{role:'user',content:prompt}]);const items=JSON.parse(raw.replace(/```json|```/g,'').trim());if(Array.isArray(items)){const db=getMemory();for(const item of items.slice(0,8)){const text=String(item).trim();if(text&&!db.memories.includes(text))db.memories.push(text);}db.memories=db.memories.slice(-5000);writeJson(memoryFile,db);}}catch{}}
async function researchAndLearn(query){const s=getSettings();if(!s.internet)return null;try{const raw=await webSearch(query);const db=readJson(webCacheFile,{pages:[]});db.pages.push({query,text:raw.slice(0,12000),at:new Date().toISOString()});db.pages=db.pages.slice(-100);writeJson(webCacheFile,db);return raw;}catch{return null;}}

ipcMain.handle('bootstrap:status',()=>readJson(bootstrapFile,{ready:false}));
ipcMain.handle('bootstrap:start',async event=>ensureOllamaAndModel(msg=>event.sender.send('bootstrap:progress',msg)));
ipcMain.handle('settings:get',()=>getSettings());
ipcMain.handle('settings:set',(_,value)=>{const old=getSettings();const next={...old,internet:Boolean(value.internet),autoLearn:Boolean(value.autoLearn),endpoint:OLLAMA_URL,model:DEFAULT_MODEL};writeJson(settingsFile,next);return next;});
ipcMain.handle('memory:get',()=>getMemory().memories);
ipcMain.handle('memory:clear',()=>{writeJson(memoryFile,{memories:[]});return [];});
ipcMain.handle('chat',async(_,payload)=>{const s=getSettings();let web='';if(s.internet&&payload.allowWeb!==false){web=await researchAndLearn(payload.message)||'';}const memory=getMemory().memories.slice(-100).join('\n- ');const system=`You are LocalMind, a private desktop AI assistant. You may use the web research below when present. Clearly distinguish facts from uncertain search results and never claim to have browsed if no research was provided. Persistent memory is below.\n\nMEMORY:\n- ${memory||'(empty)'}\n\nWEB RESEARCH:\n${web||'(none)'}`;const answer=await ollama([{role:'system',content:system},...(payload.history||[]),{role:'user',content:payload.message}]);if(s.autoLearn)learnFromConversation(payload.message,answer,web?'conversation+web':'conversation');return answer;});
ipcMain.handle('test',async()=>{await ollama([{role:'user',content:'Reply with OK.'}]);return true;});
function createWindow(){ensureData();const win=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:650,backgroundColor:'#101318',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});win.loadFile('index.html');win.webContents.once('did-finish-load',()=>ensureOllamaAndModel(msg=>win.webContents.send('bootstrap:progress',msg)).catch(()=>{}));}
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
