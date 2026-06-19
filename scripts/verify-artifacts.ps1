$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $Root 'manifest.json'
$ArtifactsDir = Join-Path $Root 'artifacts'
$Failures = New-Object System.Collections.Generic.List[string]

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { $Failures.Add($Message) }
}

Assert-True (Test-Path -LiteralPath $ManifestPath) 'manifest.json is missing.'
$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$artifacts = @($manifest.artifacts)
Assert-True ($artifacts.Count -ge 2) 'Expected at least two sample artifacts.'

foreach ($artifact in $artifacts) {
  Assert-True (-not [string]::IsNullOrWhiteSpace($artifact.id)) 'Artifact id is empty.'
  Assert-True (-not [string]::IsNullOrWhiteSpace($artifact.title)) "Artifact $($artifact.id) title is empty."
  Assert-True ((Test-Path -LiteralPath $artifact.path)) "Artifact file missing: $($artifact.path)"
  Assert-True ((Test-Path -LiteralPath $artifact.lastSnapshot)) "Snapshot file missing: $($artifact.lastSnapshot)"

  if (Test-Path -LiteralPath $artifact.path) {
    $html = Get-Content -Raw -LiteralPath $artifact.path
    Assert-True ($html -match '<!doctype html>') "Artifact $($artifact.id) is not a full HTML document."
    Assert-True ($html -match 'id="artifactContent"') "Artifact $($artifact.id) is missing the content mount."
    Assert-True ($html -match 'id="copyPrompt"') "Artifact $($artifact.id) is missing Copy Prompt."
    Assert-True ($html -match 'id="reloadPage"') "Artifact $($artifact.id) is missing Refresh."
    Assert-True ($html -notmatch 'https?://') "Artifact $($artifact.id) contains an external URL."
    Assert-True ($html -notmatch 'src\s*=') "Artifact $($artifact.id) contains a src attribute."
    Assert-True ($html -notmatch '</ul>\s*</ul>|</ol>\s*</ol>|<section>\s*</section>') "Artifact $($artifact.id) contains malformed generated markup."
  }
}

$promptLab = @($artifacts | Where-Object { $_.id -eq 'prompt-lab' }) | Select-Object -First 1
Assert-True ($null -ne $promptLab) 'prompt-lab sample artifact is missing.'
if ($null -ne $promptLab -and (Test-Path -LiteralPath $promptLab.path)) {
  $promptHtml = Get-Content -Raw -LiteralPath $promptLab.path
  Assert-True ($promptHtml -match 'data-artifact-control') 'prompt-lab is missing the interactive range control.'
  Assert-True ($promptHtml -match 'id="promptOutput"') 'prompt-lab is missing the generated prompt textarea.'
}

if ($Failures.Count -gt 0) {
  $Failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Verified $($artifacts.Count) artifacts."
Write-Output 'Checks: manifest, files, snapshots, self-contained HTML, toolbar controls, tune controls, malformed markup.'
