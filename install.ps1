[CmdletBinding()]
param(
    [ValidateSet('auto', 'ja', 'en')]
    [string]$Locale = 'auto',
    [string]$TargetRoot = (Join-Path $env:USERPROFILE 'plugins')
)

$ErrorActionPreference = 'Stop'
$pluginId = 'capacity-guard'
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$resolvedTargetRoot = [IO.Path]::GetFullPath($TargetRoot)
$targetRootPrefix = $resolvedTargetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$targetPlugin = [IO.Path]::GetFullPath((Join-Path $resolvedTargetRoot $pluginId))

if (-not $targetPlugin.StartsWith($targetRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to install outside the requested target root: $targetPlugin"
}

if ($Locale -eq 'auto') {
    $language = $null
    if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
        $languageTags = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
        if ($languageTags.Count -gt 0) {
            $language = ([Globalization.CultureInfo]::GetCultureInfo([string]$languageTags[0])).TwoLetterISOLanguageName
        }
    }
    if (-not $language) {
        $language = [Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName
    }
    $Locale = if ($language -eq 'ja') { 'ja' } else { 'en' }
}

$displayName = if ($Locale -eq 'ja') {
    -join ([char[]]@(0x4F7F, 0x3044, 0x3059, 0x304E, 0x9632, 0x6B62, 0x30E2, 0x30FC, 0x30C9))
} else {
    'Capacity Guard'
}

if (-not [IO.Directory]::Exists($resolvedTargetRoot)) {
    [IO.Directory]::CreateDirectory($resolvedTargetRoot) | Out-Null
}

if (-not $sourceRoot.Equals($targetPlugin, [StringComparison]::OrdinalIgnoreCase)) {
    if ([IO.Directory]::Exists($targetPlugin)) {
        $backup = "$targetPlugin.backup.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
        [IO.Directory]::Move($targetPlugin, $backup)
        Write-Host "Previous installation moved to: $backup"
    }
    Copy-Item -LiteralPath $sourceRoot -Destination $targetPlugin -Recurse
}

$manifestPath = Join-Path $targetPlugin '.codex-plugin\plugin.json'
$manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$manifest.interface.displayName = $displayName
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 20),
    [Text.UTF8Encoding]::new($false)
)

$skillUiPath = Join-Path $targetPlugin 'skills\capacity-guard\agents\openai.yaml'
$skillUi = [IO.File]::ReadAllText($skillUiPath, [Text.Encoding]::UTF8)
$skillUi = [Text.RegularExpressions.Regex]::Replace(
    $skillUi,
    '(?m)^\s*display_name:\s*.*$',
    "  display_name: `"$displayName`""
)
[IO.File]::WriteAllText($skillUiPath, $skillUi, [Text.UTF8Encoding]::new($false))

$marketplacePath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$marketplaceDirectory = Split-Path -Parent $marketplacePath
if (-not [IO.Directory]::Exists($marketplaceDirectory)) {
    [IO.Directory]::CreateDirectory($marketplaceDirectory) | Out-Null
}

if (Test-Path -LiteralPath $marketplacePath) {
    $marketplace = [IO.File]::ReadAllText($marketplacePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
} else {
    $marketplace = [pscustomobject]@{
        name = 'personal'
        interface = [pscustomobject]@{ displayName = 'Personal' }
        plugins = @()
    }
}

$entries = @($marketplace.plugins | Where-Object { $_.name -ne $pluginId })
$defaultPluginRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'plugins'))
$marketplaceSource = if ($resolvedTargetRoot.Equals($defaultPluginRoot, [StringComparison]::OrdinalIgnoreCase)) {
    './plugins/capacity-guard'
} else {
    $targetPlugin.Replace('\', '/')
}
$entries += [pscustomobject]@{
    name = $pluginId
    source = [pscustomobject]@{ source = 'local'; path = $marketplaceSource }
    policy = [pscustomobject]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
    category = 'Productivity'
}
$marketplace.plugins = $entries
[IO.File]::WriteAllText(
    $marketplacePath,
    ($marketplace | ConvertTo-Json -Depth 20),
    [Text.UTF8Encoding]::new($false)
)

$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& codex plugin remove "$pluginId@personal" *> $null
$ErrorActionPreference = $previousErrorPreference

& codex plugin add "$pluginId@personal"
if ($LASTEXITCODE -ne 0) {
    throw "Codex could not install $pluginId from the personal marketplace."
}

Write-Host "Installed $displayName ($pluginId), locale=$Locale"
Write-Host 'Restart Codex before using the plugin in a new task.'
