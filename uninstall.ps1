[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
& codex plugin remove 'capacity-guard@personal'
if ($LASTEXITCODE -ne 0) {
    throw 'Codex could not remove capacity-guard.'
}

Write-Host 'Capacity Guard was disabled and removed from the Codex installation cache.'
Write-Host 'Plugin source and personal marketplace entry were preserved for recovery or reinstall.'
