# Builds the app and tray icons from the approved Miu v0.4 head layers.
#
#   powershell -ExecutionPolicy Bypass -File scripts/gen-icons.ps1
#
# Windows only (System.Drawing).

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$rig = Join-Path $root "public\miu-rig\assets"
$out = Join-Path $root "src-tauri\icons"

# Back to front; every layer is on the same 1024 x 1024 canvas (rig.json).
$stack = @(
  "layers\ear_L.png", "layers\ear_R.png", "layers\head.png",
  "layers\blush_L.png", "layers\blush_R.png",
  "layers\eye_white_L.png", "layers\eye_white_R.png",
  "layers\iris_L.png", "layers\iris_R.png",
  "layers\brow_L.png", "layers\brow_R.png", "layers\nose.png", "layers\mouth_smile.png"
)

$canvas = New-Object System.Drawing.Bitmap 1024, 1024, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($canvas)
foreach ($layer in $stack) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $rig $layer))
  $g.DrawImage($img, 0, 0, 1024, 1024)
  $img.Dispose()
}
$g.Dispose()

# Bounding box of the visible pixels.
$rect = New-Object System.Drawing.Rectangle 0, 0, 1024, 1024
$data = $canvas.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * 1024)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$canvas.UnlockBits($data)
$minX = 1024; $minY = 1024; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt 1024; $y++) {
  $row = $y * $data.Stride
  for ($x = 0; $x -lt 1024; $x++) {
    if ($bytes[$row + $x * 4 + 3] -gt 8) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}

# Square around the head, with a little air so nothing touches the edge.
$side = [Math]::Max($maxX - $minX + 1, $maxY - $minY + 1)
$side = [int][Math]::Ceiling($side * 1.04)
$cx = ($minX + $maxX + 1) / 2
$cy = ($minY + $maxY + 1) / 2
$src = New-Object System.Drawing.RectangleF ([float]($cx - $side / 2)), ([float]($cy - $side / 2)), ([float]$side), ([float]$side)
Write-Host "head box: x $minX-$maxX, y $minY-$maxY -> square $side px"

function Render([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gr.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $dst = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $gr.DrawImage($canvas, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $gr.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

New-Item -ItemType Directory -Force $out | Out-Null
$files = @{ "32x32.png" = 32; "128x128.png" = 128; "128x128@2x.png" = 256; "icon.png" = 512 }
foreach ($name in $files.Keys) {
  $png = Render $files[$name]
  [System.IO.File]::WriteAllBytes((Join-Path $out $name), $png)
  Write-Host "$name - $($png.Length) bytes"
}

# PNG-in-ICO (Vista and later). 16/20/24/32 cover the tray at 100-200 % scaling.
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$pngs = @($sizes | ForEach-Object { ,(Render $_) })
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $out "icon.ico"), $ico.ToArray())
Write-Host "icon.ico - $($ico.Length) bytes"
$canvas.Dispose()
