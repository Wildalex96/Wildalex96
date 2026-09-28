# Run once as Administrator.
$feature = Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM
if ($feature.State -ne 'Enabled') { Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart }
Write-Host 'Windows Sandbox feature enabled. Restart Windows before using LocalMind isolated code execution.'
