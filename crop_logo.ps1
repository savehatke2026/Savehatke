Add-Type -AssemblyName System.Drawing

$src = 'C:\Users\Rupayan\Desktop\SaveHatke\public\savehatke.png'
$img = [System.Drawing.Bitmap]::FromFile($src)
$w = $img.Width   # 2065
$h = $img.Height  # 761

# Fixed crop for the "S" icon only (speed lines + S + % tag + swoosh),
# stopping before the "Savehatke" wordmark which starts at x=760.
$L = 52
$T = 66
$R = 752
$B = 700
$cw = $R - $L + 1
$ch = $B - $T + 1

$rect = New-Object System.Drawing.Rectangle($L, $T, $cw, $ch)
$crop = $img.Clone($rect, $img.PixelFormat)
$out = 'C:\Users\Rupayan\Desktop\SaveHatke\public\logo-icon.png'
$crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
$img.Dispose()
[System.IO.File]::WriteAllText('C:\Users\Rupayan\Desktop\SaveHatke\cropinfo.txt', "CROP L=$L T=$T W=$cw H=$ch saved=$out")
