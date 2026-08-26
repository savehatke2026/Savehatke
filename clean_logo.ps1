Add-Type -AssemblyName System.Drawing

# The smoke halo is SEMI-TRANSPARENT (alpha 3-172); the icon is OPAQUE (alpha 243-251).
# Brightness/saturation overlap, so alpha is the only reliable discriminator.
# 1) Edge flood-fill erases connected semi-transparent smoke, stopping at the opaque icon.
# 2) Auto-crop to the remaining opaque bounding box so the S fills the frame.
$src = 'C:\Users\Rupayan\Desktop\SaveHatke\public\logo-icon.png'
$out = 'C:\Users\Rupayan\Desktop\SaveHatke\public\logo-final.png'
$A_T = 210   # alpha below this (and edge-connected) = smoke -> erase

$img = New-Object System.Drawing.Bitmap ([System.Drawing.Bitmap]::FromFile($src))
$w = $img.Width
$h = $img.Height

$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object 'byte[]' ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

$visited = New-Object 'byte[]' ($w * $h)
$stack = New-Object System.Collections.Generic.Stack[int]
for ($x = 0; $x -lt $w; $x++) { $stack.Push($x); $stack.Push((($h - 1) * $w) + $x) }
for ($y = 0; $y -lt $h; $y++) { $stack.Push($y * $w); $stack.Push(($y * $w) + ($w - 1)) }

while ($stack.Count -gt 0) {
  $p = $stack.Pop()
  if ($visited[$p]) { continue }
  $visited[$p] = 1
  $x = $p % $w
  $y = [int][Math]::Floor($p / $w)
  $i = ($y * $stride) + ($x * 4)

  if ($bytes[$i + 3] -lt $A_T) {
    $bytes[$i + 3] = 0
    if ($x -gt 0)      { $stack.Push($p - 1) }
    if ($x -lt $w - 1) { $stack.Push($p + 1) }
    if ($y -gt 0)      { $stack.Push($p - $w) }
    if ($y -lt $h - 1) { $stack.Push($p + $w) }
  }
}

# --- bounding box of remaining opaque pixels ---
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    if ($bytes[$row + $x * 4 + 3] -gt 20) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}

[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$img.UnlockBits($data)

$pad = 8
$minX = [Math]::Max(0, $minX - $pad); $minY = [Math]::Max(0, $minY - $pad)
$maxX = [Math]::Min($w - 1, $maxX + $pad); $maxY = [Math]::Min($h - 1, $maxY + $pad)
$cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1

$crop = New-Object System.Drawing.Rectangle $minX, $minY, $cw, $ch
$cropped = $img.Clone($crop, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$cropped.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$cropped.Dispose()
$img.Dispose()
[System.IO.File]::WriteAllText('C:\Users\Rupayan\Desktop\SaveHatke\cropinfo.txt', "cleaned+cropped $out  bbox=($minX,$minY)-($maxX,$maxY)  final=${cw}x${ch}")
