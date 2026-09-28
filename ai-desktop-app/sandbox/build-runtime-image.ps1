$ErrorActionPreference='Stop'
$root=Join-Path $PSScriptRoot 'runtime-image'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$manifest=@{
  name='LocalMind Sandbox Runtime'; version='1.0'; networking=$false
  runtimes=@('Python','Node.js','TypeScript','PowerShell','C/C++','C#/.NET','Java','Go','Rust','Ruby','PHP','Kotlin','Swift','Lua','R','Perl','Bash','SQLite')
} | ConvertTo-Json -Depth 4
$manifest | Set-Content (Join-Path $root 'runtime-manifest.json') -Encoding UTF8
@'
$ErrorActionPreference='Stop'
$required=@('python','node','npm','powershell','gcc','g++','dotnet','java','javac','go','rustc','ruby','php','kotlinc','swiftc','lua','Rscript','perl','bash','sqlite3')
$missing=@()
foreach($x in $required){ if(-not (Get-Command $x -ErrorAction SilentlyContinue)){ $missing+=$x } }
if($missing.Count){ Write-Error ('Missing runtime(s): '+($missing -join ', ')); exit 2 }
Write-Output 'LocalMind runtime validation OK'
'@ | Set-Content (Join-Path $root 'validate-runtime.ps1') -Encoding UTF8
Write-Output "Runtime image manifest created at $root"
Write-Output 'Note: Windows Sandbox uses the host OS runtime set; this script validates that every configured compiler/interpreter is installed on the build/test machine.'
