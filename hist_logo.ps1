Add-Type -AssemblyName System.Drawing

$src = 'C:\Users\Rupayan\Desktop\SaveHatke\public\savehatke.png'
$img = [System.Drawing.Bitmap]::FromFile($src)
$w = $img.Width
$h = $img.Height

$counts = New-Object 'int[]' $w
for ($x = 0; $x -lt $w; $x++) {
  $c = 0
  for ($y = 0; $y -lt $h; $y += 2) {
    $p = $img.GetPixel($x, $y)
    if ($p.A -gt 200) {
      $sat = $p.GetSaturation()
      $bri = $p.GetBrightness()
      if ($sat -gt 0.45 -and $bri -gt 0.28) { $c++ }
    }
  }
  $counts[$x] = $c
}

# Binned histogram, bin width 40px
$bin = 40
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("W=$w H=$h bin=$bin")
for ($b = 0; $b -lt $w; $b += $bin) {
  $sum = 0
  $end = [Math]::Min($w - 1, $b + $bin - 1)
  for ($x = $b; $x -le $end; $x++) { $sum += $counts[$x] }
  $avg = [int]($sum / $bin)
  $bar = '#' * [Math]::Min(60, $avg)
  [void]$sb.AppendLine(("{0,4}-{1,4}: {2,4} {3}" -f $b, $end, $avg, $bar))
}
$img.Dispose()
$sb.ToString() | Out-File -FilePath 'C:\Users\Rupayan\Desktop\SaveHatke\hist.txt' -Encoding ascii
