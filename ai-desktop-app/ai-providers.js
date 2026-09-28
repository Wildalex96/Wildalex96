const https=require('https');

function postJson(url,body,headers={}){return new Promise((resolve,reject)=>{const u=new URL(url);const data=JSON.stringify(body);const req=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...headers}},res=>{let x='';res.setEncoding('utf8');res.on('data',c=>x+=c);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error(`HTTP ${res.statusCode}: ${x.slice(0,500)}`));try{resolve(JSON.parse(x))}catch(e){reject(e)}})});req.on('error',reject);req.write(data);req.end()})}

function env(name){return process.env[name]||''}
function providers(){return [
 {id:'ollama',name:'Ollama',kind:'ollama',endpoint:env('LOCALMIND_OLLAMA_URL')||'http://127.0.0.1:11434',model:env('LOCALMIND_OLLAMA_MODEL')||''},
 {id:'openai',name:'OpenAI',kind:'openai',endpoint:'https://api.openai.com/v1',key:env('OPENAI_API_KEY'),model:env('OPENAI_MODEL')||'gpt-4o-mini'},
 {id:'anthropic',name:'Anthropic',kind:'anthropic',endpoint:'https://api.anthropic.com/v1',key:env('ANTHROPIC_API_KEY'),model:env('ANTHROPIC_MODEL')||'claude-3-5-haiku-latest'},
 {id:'gemini',name:'Google Gemini',kind:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta',key:env('GEMINI_API_KEY'),model:env('GEMINI_MODEL')||'gemini-2.0-flash'}
].filter(p=>p.kind==='ollama'||p.key)}

async function call(p,messages){if(p.kind==='ollama'){const r=await fetch(p.endpoint+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:p.model,messages,stream:false})});if(!r.ok)throw Error(`${p.name} HTTP ${r.status}`);return (await r.json()).message?.content||''}
 if(p.kind==='openai'){const r=await postJson(p.endpoint+'/chat/completions',{model:p.model,messages,temperature:.2},{Authorization:`Bearer ${p.key}`});return r.choices?.[0]?.message?.content||''}
 if(p.kind==='anthropic'){const system=messages.find(x=>x.role==='system')?.content||'';const msgs=messages.filter(x=>x.role!=='system');const r=await postJson(p.endpoint+'/messages',{model:p.model,max_tokens:4096,system,messages:msgs},{'x-api-key':p.key,'anthropic-version':'2023-06-01'});return (r.content||[]).map(x=>x.text||'').join('')}
 if(p.kind==='gemini'){const text=messages.map(x=>`${x.role}: ${x.content}`).join('\n');const r=await postJson(`${p.endpoint}/models/${p.model}:generateContent?key=${encodeURIComponent(p.key)}`,{contents:[{parts:[{text}]}]});return r.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||''}
 throw Error('Unknown provider');}

async function askAll(messages,{timeoutMs=30000}={}){const ps=providers();const results=await Promise.all(ps.map(async p=>{try{return {provider:p.id,name:p.name,text:await Promise.race([call(p,messages),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),timeoutMs))])}}catch(e){return {provider:p.id,name:p.name,error:e.message}}}));return results.filter(x=>x.text)}

async function synthesize(primary,question,answers){const joined=answers.map(x=>`[${x.name}]\n${x.text}`).join('\n\n');return call(primary,[{role:'system',content:'You are the synthesis model for LocalMind. Compare independent AI answers, identify disagreements, uncertainty and unsupported claims. Produce a concise, factual answer. Do not treat another AI as an authoritative source.'},{role:'user',content:`Question: ${question}\n\nIndependent AI answers:\n${joined}`}])}

async function multiAI(question,baseMessages=[],opts={}){const ps=providers();if(!ps.length)return{answer:'',sources:[]};const messages=[...baseMessages,{role:'user',content:question}];const answers=await askAll(messages,opts);if(!answers.length)throw Error('Все AI-провайдеры недоступны');const primary=ps.find(p=>p.id===(opts.primary||'ollama'))||ps[0];if(answers.length===1)return{answer:answers[0].text,sources:answers};return{answer:await synthesize(primary,question,answers),sources:answers};}
module.exports={providers,call,askAll,multiAI};
