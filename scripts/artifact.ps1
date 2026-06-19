param(
  [Parameter(Position = 0)]
  [ValidateSet('new', 'update', 'open', 'list', 'help')]
  [string]$Command = 'help',

  [Parameter(Position = 1)]
  [string]$ArtifactId,

  [string]$Title,
  [ValidateSet('dashboard', 'pr', 'compare', 'tune')]
  [string]$Type = 'dashboard',
  [string]$From
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ArtifactsDir = Join-Path $Root 'artifacts'
$VersionsDir = Join-Path $ArtifactsDir 'versions'
$TemplatesDir = Join-Path $Root 'templates'
$ManifestPath = Join-Path $Root 'manifest.json'

function Ensure-Layout {
  New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $VersionsDir | Out-Null
  if (-not (Test-Path -LiteralPath $ManifestPath)) {
    @{ artifacts = @() } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
  }
}

function Read-Manifest {
  Ensure-Layout
  $raw = Get-Content -Raw -LiteralPath $ManifestPath
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{ artifacts = @() }
  }
  $manifest = $raw | ConvertFrom-Json
  if ($null -eq $manifest.artifacts) {
    $manifest | Add-Member -NotePropertyName artifacts -NotePropertyValue @()
  }
  return $manifest
}

function Save-Manifest($Manifest) {
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
}

function New-Slug([string]$Value) {
  $slug = $Value.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $slug = $slug.Trim('-')
  if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'artifact' }
  return $slug
}

function Escape-Html([string]$Value) {
  if ($null -eq $Value) { return '' }
  return [System.Net.WebUtility]::HtmlEncode($Value)
}

function Convert-InlineMarkdown([string]$Value) {
  $encoded = Escape-Html $Value
  $encoded = [regex]::Replace($encoded, '\*\*([^*]+)\*\*', '<strong>$1</strong>')
  $encoded = [regex]::Replace($encoded, '`([^`]+)`', '<code>$1</code>')
  return $encoded
}

function Convert-MarkdownToHtml([string]$Markdown) {
  $lines = $Markdown -split "`r?`n"
  $html = New-Object System.Collections.Generic.List[string]
  $paragraph = New-Object System.Collections.Generic.List[string]
  $code = New-Object System.Collections.Generic.List[string]
  $table = New-Object System.Collections.Generic.List[string]
  $state = @{
    InCode = $false
    List = ''
    SectionOpen = $false
  }

  function Ensure-Section {
    if (-not $state.SectionOpen) {
      $html.Add('<section>')
      $state.SectionOpen = $true
    }
  }

  function Flush-Paragraph {
    if ($paragraph.Count -gt 0) {
      $text = ($paragraph -join ' ').Trim()
      if ($text.Length -gt 0) {
        Ensure-Section
        $html.Add("<p>$(Convert-InlineMarkdown $text)</p>")
      }
      $paragraph.Clear()
    }
  }

  function Close-List {
    if ($state.List -eq 'ul') { $html.Add('</ul>') }
    if ($state.List -eq 'ol') { $html.Add('</ol>') }
    $state.List = ''
  }

  function Flush-Table {
    if ($table.Count -eq 0) { return }
    $rows = @($table)
    $table.Clear()
    if ($rows.Count -lt 2) { return }
    Ensure-Section
    $html.Add('<table>')
    for ($i = 0; $i -lt $rows.Count; $i++) {
      if ($i -eq 1 -and $rows[$i] -match '^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$') { continue }
      $cells = $rows[$i].Trim().Trim('|') -split '\|'
      $tag = if ($i -eq 0) { 'th' } else { 'td' }
      $html.Add('<tr>')
      foreach ($cell in $cells) {
        $html.Add("<$tag>$(Convert-InlineMarkdown ($cell.Trim()))</$tag>")
      }
      $html.Add('</tr>')
    }
    $html.Add('</table>')
  }

  function Start-Section([string]$HeadingHtml) {
    Flush-Paragraph
    Close-List
    Flush-Table
    if ($state.SectionOpen) { $html.Add('</section>') }
    $html.Add("<section><h2>$HeadingHtml</h2>")
    $state.SectionOpen = $true
  }

  foreach ($line in $lines) {
    if ($line -match '^\s*```\s*([A-Za-z0-9_-]+)?\s*$') {
      Flush-Paragraph
      Close-List
      Flush-Table
      if ($state.InCode) {
        Ensure-Section
        $html.Add('<pre><code>' + (Escape-Html ($code -join "`n")) + '</code></pre>')
        $code.Clear()
        $state.InCode = $false
      } else {
        $state.InCode = $true
      }
      continue
    }

    if ($state.InCode) {
      $code.Add($line)
      continue
    }

    if ($line -match '^\s*$') {
      Flush-Paragraph
      Close-List
      Flush-Table
      continue
    }

    if ($line -match '^\s*<.+>\s*$') {
      Flush-Paragraph
      Close-List
      Flush-Table
      Ensure-Section
      $html.Add($line)
      continue
    }

    if ($line -match '^\s*\|.*\|\s*$') {
      Flush-Paragraph
      Close-List
      $table.Add($line)
      continue
    } else {
      Flush-Table
    }

    if ($line -match '^(#{1,3})\s+(.+)$') {
      Flush-Paragraph
      Close-List
      $level = $Matches[1].Length
      $text = Convert-InlineMarkdown $Matches[2].Trim()
      if ($level -eq 1) { continue }
      if ($level -eq 2) { Start-Section $text } else { Ensure-Section; $html.Add("<h3>$text</h3>") }
      continue
    }

    if ($line -match '^\s*[-*]\s+(.+)$') {
      Flush-Paragraph
      Ensure-Section
      if ($state.List -ne 'ul') { Close-List; $html.Add('<ul>'); $state.List = 'ul' }
      $html.Add("<li>$(Convert-InlineMarkdown $Matches[1].Trim())</li>")
      continue
    }

    if ($line -match '^\s*\d+\.\s+(.+)$') {
      Flush-Paragraph
      Ensure-Section
      if ($state.List -ne 'ol') { Close-List; $html.Add('<ol>'); $state.List = 'ol' }
      $html.Add("<li>$(Convert-InlineMarkdown $Matches[1].Trim())</li>")
      continue
    }

    if ($line -match '^\s*>\s+(.+)$') {
      Flush-Paragraph
      Close-List
      Ensure-Section
      $html.Add("<blockquote>$(Convert-InlineMarkdown $Matches[1].Trim())</blockquote>")
      continue
    }

    $paragraph.Add($line.Trim())
  }

  if ($state.InCode) {
    Ensure-Section
    $html.Add('<pre><code>' + (Escape-Html ($code -join "`n")) + '</code></pre>')
  }
  Flush-Paragraph
  Close-List
  Flush-Table
  if ($state.SectionOpen) { $html.Add('</section>') }

  return $html -join "`n"
}

function Get-DefaultContent([string]$ArtifactType) {
  $path = Join-Path $TemplatesDir "$ArtifactType.md"
  return Get-Content -Raw -LiteralPath $path
}

function Get-InputContent([string]$Path, [string]$ArtifactType) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return Get-DefaultContent $ArtifactType
  }
  if ($Path -eq '-') {
    return [Console]::In.ReadToEnd()
  }
  return Get-Content -Raw -LiteralPath $Path
}

function Get-Summary([string]$Content, [string]$ArtifactType) {
  $plain = [regex]::Replace($Content, '<[^>]+>', ' ')
  $plain = [regex]::Replace($plain, '[#>*`|\-]+', ' ')
  $plain = [regex]::Replace($plain, '\s+', ' ').Trim()
  if ($plain.Length -gt 150) { return $plain.Substring(0, 150) + '...' }
  if ($plain.Length -gt 0) { return $plain }
  return "A local Codex $ArtifactType artifact."
}

function Render-Artifact($Artifact, [string]$Content) {
  $template = Get-Content -Raw -LiteralPath (Join-Path $TemplatesDir 'shell.html')
  $trimmed = $Content.TrimStart()
  $body = if ($trimmed -match '^(?is)<!doctype\s+html|<html[\s>]|<section[\s>]') { $Content } else { Convert-MarkdownToHtml $Content }
  $replacements = @{
    '{{TITLE}}' = Escape-Html $Artifact.title
    '{{TYPE}}' = Escape-Html $Artifact.type
    '{{VERSION}}' = [string]$Artifact.version
    '{{UPDATED_AT}}' = Escape-Html $Artifact.updatedAt
    '{{SOURCE}}' = Escape-Html $Artifact.source
    '{{SUMMARY}}' = Escape-Html (Get-Summary $Content $Artifact.type)
    '{{CONTENT}}' = $body
  }
  foreach ($key in $replacements.Keys) {
    $template = $template.Replace($key, $replacements[$key])
  }
  return $template
}

function Find-Artifact($Manifest, [string]$Id) {
  $artifact = @($Manifest.artifacts | Where-Object { $_.id -eq $Id }) | Select-Object -First 1
  if ($null -eq $artifact) { throw "Artifact '$Id' was not found." }
  return $artifact
}

function Save-ArtifactFiles($Artifact, [string]$Content) {
  $html = Render-Artifact $Artifact $Content
  $path = Join-Path $ArtifactsDir "$($Artifact.id).html"
  $snapshot = Join-Path $VersionsDir "$($Artifact.id)-v$($Artifact.version)-$((Get-Date).ToString('yyyyMMdd-HHmmss')).html"
  Set-Content -LiteralPath $path -Value $html -Encoding UTF8
  Set-Content -LiteralPath $snapshot -Value $html -Encoding UTF8
  $Artifact.path = $path
  $Artifact.lastSnapshot = $snapshot
  return $path
}

function Show-Help {
  @'
Codex Local Artifacts

Usage:
  artifact new --title "Project Pulse" --type dashboard
  artifact update <id> --from <file-or-stdin>
  artifact open <id>
  artifact list

Types:
  dashboard, pr, compare, tune
'@
}

Ensure-Layout

$lockName = 'Local\CodexArtifactsMvpManifest'
$mutex = [System.Threading.Mutex]::new($false, $lockName)
$hasLock = $false

try {
  $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
  if (-not $hasLock) { throw 'Timed out waiting for artifact manifest lock.' }

  switch ($Command) {
    'new' {
      if ([string]::IsNullOrWhiteSpace($Title)) { $Title = 'Codex Artifact' }
      $manifest = Read-Manifest
      $base = New-Slug $Title
      $id = $base
      $index = 2
      while (@($manifest.artifacts | Where-Object { $_.id -eq $id }).Count -gt 0) {
        $id = "$base-$index"
        $index++
      }
      $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
      $source = if ([string]::IsNullOrWhiteSpace($From)) { "templates/$Type.md" } elseif ($From -eq '-') { 'stdin' } else { (Resolve-Path -LiteralPath $From).Path }
      $artifact = [pscustomobject]@{
        id = $id
        title = $Title
        type = $Type
        version = 1
        createdAt = $now
        updatedAt = $now
        source = $source
        path = ''
        lastSnapshot = ''
      }
      $content = Get-InputContent $From $Type
      $path = Save-ArtifactFiles $artifact $content
      $manifest.artifacts = @($manifest.artifacts) + $artifact
      Save-Manifest $manifest
      Write-Output "Created $id"
      Write-Output $path
    }
    'update' {
      if ([string]::IsNullOrWhiteSpace($ArtifactId)) { throw 'Missing artifact id.' }
      $manifest = Read-Manifest
      $artifact = Find-Artifact $manifest $ArtifactId
      $content = Get-InputContent $From $artifact.type
      $artifact.version = [int]$artifact.version + 1
      $artifact.updatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
      if (-not [string]::IsNullOrWhiteSpace($From)) {
        $artifact.source = if ($From -eq '-') { 'stdin' } else { (Resolve-Path -LiteralPath $From).Path }
      }
      $path = Save-ArtifactFiles $artifact $content
      Save-Manifest $manifest
      Write-Output "Updated $ArtifactId to v$($artifact.version)"
      Write-Output $path
    }
    'open' {
      if ([string]::IsNullOrWhiteSpace($ArtifactId)) { throw 'Missing artifact id.' }
      $manifest = Read-Manifest
      $artifact = Find-Artifact $manifest $ArtifactId
      if (-not (Test-Path -LiteralPath $artifact.path)) { throw "Artifact file does not exist: $($artifact.path)" }
      Start-Process -FilePath $artifact.path
      Write-Output "Opened $($artifact.path)"
    }
    'list' {
      $manifest = Read-Manifest
      $items = @($manifest.artifacts)
      if ($items.Count -eq 0) {
        Write-Output 'No artifacts yet.'
      } else {
        $items | Select-Object id, title, type, version, updatedAt, path | Format-Table -AutoSize
      }
    }
    default {
      Show-Help
    }
  }
} finally {
  if ($hasLock) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}
