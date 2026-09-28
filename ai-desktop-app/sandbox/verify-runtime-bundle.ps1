[CmdletBinding()]
param([string]$Root='C:\LocalMind\runtime')
$ErrorActionPreference='Stop'
$manifest=Get-Content (Join-Path $Root 'runtime-bundle.json') -Raw | ConvertFrom-Json
$checks=@('python --version','node --version','npm --version','dotnet --version','java -version','javac -version','go version','rustc --version','ruby --version','php --version','kotlinc -version','lua -v','Rscript --version','perl -v','bash --version','sqlite3 --version','gcc --version','g++ --version','powershell -Version')
$results=@()
foreach($c in $checks){
  try { $p=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command',$c -Wait -PassThru -RedirectStandardOutput (Join-Path $env:TEMP 'lm-out.txt') -RedirectStandardError (Join-Path $env:TEMP 'lm-err.txt');$results+=[pscustomobject]@{command=$c;exitCode=$p.ExitCode;ok=($p.ExitCode -eq 0)} } catch {$results+=[pscustomobject]@{command=$c;exitCode=-1;ok=$false}}
}
$results | ConvertTo-Json | Set-Content (Join-Path $Root 'runtime-validation.json') -Encoding UTF8
if(@($results | Where-Object {-not $_.ok}).Count){ Write-Warning 'One or more runtime checks failed.'; exit 2 }
Write-Output 'All configured runtime checks passed.'
