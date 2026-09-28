const fs=require('fs');const path=require('path');const os=require('os');const {spawn}=require('child_process');

function runProcess(exe,args,opts={}){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true,...opts});let stdout='',stderr='';p.stdout?.on('data',d=>stdout+=d);p.stderr?.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});}
function psQuote(s){return `'${String(s).replace(/'/g,"''")}'`;}

/** Run untrusted code inside a disposable Windows Sandbox VM.
 * No host filesystem is mounted. Networking is disabled. Only C:\work\out is returned.
 */
async function runInWindowsSandbox({code,language='python',inputFiles=[]}){
  if(process.platform!=='win32')throw new Error('Windows Sandbox runner is available only on Windows.');
  if(!code||code.length>1024*1024)throw new Error('Code is empty or exceeds 1 MB.');
  const sandboxExe=process.env.WINDIR+'\\System32\\WindowsSandbox.exe';
  if(!fs.existsSync(sandboxExe))throw new Error('Windows Sandbox is not enabled. Enable "Windows Sandbox" in Windows Features.');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'localmind-sbx-'));const work=path.join(root,'work');fs.mkdirSync(path.join(work,'out'),{recursive:true});
  try{
    for(const f of inputFiles){if(!f?.name||typeof f.content!=='string')continue;const safe=path.basename(f.name);if(safe==='.'||safe==='..')continue;fs.writeFileSync(path.join(work,safe),f.content,{encoding:'utf8'});}
    const ext=language==='javascript'?'js':language==='powershell'?'ps1':'py';
    const scriptName='main.'+ext;fs.writeFileSync(path.join(work,scriptName),code,'utf8');
    const command=language==='javascript'?`node C:\\work\\${scriptName}`:language==='powershell'?`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\work\\${scriptName}`:`python C:\\work\\${scriptName}`;
    const wsb=`<Configuration><Networking>Disable</Networking><MappedFolders><MappedFolder><HostFolder>${work.replace(/\\/g,'\\\\')}</HostFolder><SandboxFolder>C:\\work</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><CommandLine>${command.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</CommandLine></LogonCommand></Configuration>`;
    const wsbPath=path.join(root,'job.wsb');fs.writeFileSync(wsbPath,wsb,'utf8');
    const result=await runProcess(sandboxExe,[wsbPath],{timeout:120000});
    const outDir=path.join(work,'out');const outputs=[];for(const name of fs.readdirSync(outDir)){const p=path.join(outDir,name);if(fs.statSync(p).isFile()&&fs.statSync(p).size<=10*1024*1024)outputs.push({name,content:fs.readFileSync(p,'base64')});}
    return {code:result.code,stdout:result.stdout.slice(0,100000),stderr:result.stderr.slice(0,100000),outputs};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={runInWindowsSandbox};
