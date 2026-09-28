[CmdletBinding()]
param([string]$Bundle=(Join-Path $PSScriptRoot 'LocalMind-RuntimeBundle-win-x64.zip'),[string]$InstallRoot='C:\LocalMind\runtime')
$ErrorActionPreference='Stop'
if(-not (Test-Path $Bundle)){throw "Runtime bundle not found: $Bundle"}
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Expand-Archive -Path $Bundle -DestinationPath $InstallRoot -Force
$manifest=Join-Path $InstallRoot 'runtime-bundle.json'
if(-not (Test-Path $manifest)){throw 'Runtime manifest missing'}
Write-Output "Installed LocalMind runtime bundle to $InstallRoot"
Write-Output 'Note: this installer validates the bundle; compiler binaries must be included by the signed distribution build.'
