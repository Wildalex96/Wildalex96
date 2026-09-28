[CmdletBinding()]
param(
  [string]$Output = (Join-Path $PSScriptRoot 'dist'),
  [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
$manifest=Get-Content (Join-Path $PSScriptRoot 'runtime-bundle.json') -Raw | ConvertFrom-Json
$stage=Join-Path $env:TEMP ('localmind-runtime-'+[guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  Copy-Item (Join-Path $PSScriptRoot 'runtime-bundle.json') $stage
  if($ValidateOnly){ Write-Output 'Manifest validation OK'; exit 0 }
  foreach($r in $manifest.runtimes){
    if($r.optional){ Write-Warning "Optional runtime: $($r.id) - build host must provide it." }
  }
  $tools=@('python','node','npm','dotnet','java','javac','go','rustc','ruby','php','kotlinc','lua','Rscript','perl','bash','sqlite3','gcc','g++','powershell')
  $missing=@($tools | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
  if($missing.Count){ throw ('Missing required build-host tools: '+($missing -join ', ')) }
  $out=Join-Path $Output 'LocalMind-RuntimeBundle'
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  Copy-Item $stage\* $out -Recurse -Force
  $zip=Join-Path $Output 'LocalMind-RuntimeBundle-win-x64.zip'
  if(Test-Path $zip){Remove-Item $zip -Force}
  Compress-Archive -Path "$out\*" -DestinationPath $zip -CompressionLevel Optimal
  $hash=(Get-FileHash $zip -Algorithm SHA256).Hash
  "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content (Join-Path $Output 'SHA256SUMS.txt')
  Write-Output "Runtime bundle created: $zip"
} finally { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
