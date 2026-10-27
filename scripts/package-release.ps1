$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$releaseDir = Join-Path $projectRoot 'release'
$exeName = "MiuLite-$version-portable.exe"
$zipPath = Join-Path $releaseDir "MiuLite-$version-portable.zip"
$files = @($exeName, 'README.md', 'LICENSE', 'LICENSE-ASSETS.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'DEPENDENCIES.md')
$sources = @((Join-Path $releaseDir $exeName)) + @($files[1..($files.Length-1)] | ForEach-Object { Join-Path $projectRoot $_ })
foreach ($path in $sources) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing release file: $path" }
}
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  for ($i = 0; $i -lt $files.Length; $i++) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $sources[$i], $files[$i], [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
$checksum = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [System.IO.Path]::GetFileName($zipPath) + "`n"
[System.IO.File]::WriteAllText((Join-Path $releaseDir 'SHA256SUMS.txt'), $checksum, [System.Text.UTF8Encoding]::new($false))
Write-Output "Portable ZIP with license notices: $zipPath"
