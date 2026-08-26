# Site-wide brand-icon swap: replace the emoji/old-logo brand marks with the
# clean transparent S logo (logo.png) and neutralise the gradient box so the
# icon's own glow blends into the dark theme. Literal replacements only.
$dir = 'C:\Users\Rupayan\Desktop\SaveHatke\public'
$enc = New-Object System.Text.UTF8Encoding($false)

# Build emoji literals by codepoint to avoid any script-encoding issues
$moneybag = [System.Char]::ConvertFromUtf32(0x1F4B0)              # money bag
$ticket   = [System.Char]::ConvertFromUtf32(0x1F39F) + [char]0xFE0F  # admission ticket + VS16

$newImg = '<img src="logo.png" alt="SaveHatke" class="brand-icon">'

# --- HTML markup replacements (old -> new) ---
$htmlPairs = @(
  @("<div class=`"brand-icon`">$moneybag</div>", $newImg),
  @('<span class="brand-icon"><img src="logo-icon.png" alt="SaveHatke" /></span>', $newImg),
  @('<div class="brand-icon"><img src="logo-icon.png" alt="SaveHatke" /></div>', $newImg),
  @('<div class="brand-icon">SH</div>', $newImg),
  @("<span class=`"brand-icon`">$ticket</span>", $newImg)
)

# --- CSS rule replacements (old -> new) ---
$css34   = '.brand-icon { width:34px; height:34px; object-fit:contain; flex-shrink:0; }'
$css32   = '.brand-icon { width:32px; height:32px; object-fit:contain; flex-shrink:0; }'
$cssPairs = @(
  @('.brand-icon { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#00e676,#4fc3f7); display:flex; align-items:center; justify-content:center; font-size:1rem; }', $css34),
  @('.brand-icon { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#00e676,#4fc3f7); display:flex; align-items:center; justify-content:center; font-size:1rem; overflow:hidden; }', $css34),
  @('.brand-icon { width:32px; height:32px; border-radius:9px; background:linear-gradient(135deg,#00e676,#4fc3f7); display:flex; align-items:center; justify-content:center; font-size:.95rem; }', $css32),
  @('.brand-icon{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#00e676,#4fc3f7);display:flex;align-items:center;justify-content:center;font-size:.95rem;flex-shrink:0}', '.brand-icon{width:32px;height:32px;object-fit:contain;flex-shrink:0}'),
  @('.brand-icon{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#00e676,#4fc3f7);display:flex;align-items:center;justify-content:center;font-size:.9rem}', '.brand-icon{width:30px;height:30px;object-fit:contain;flex-shrink:0}')
)

# login.html multiline CSS block
$loginOld = @"
    .brand-icon {
      width:34px; height:34px; border-radius:9px;
      background:linear-gradient(135deg,#00e676,#4fc3f7);
      display:flex; align-items:center; justify-content:center;
      font-size:.9rem; font-weight:900; color:#060d1f;
    }
"@
$loginNew = @"
    .brand-icon {
      width:34px; height:34px; object-fit:contain; flex-shrink:0;
    }
"@

$files = @('index.html','marketplace.html','sell.html','how-it-works.html','about.html',
           'support.html','terms.html','privacy.html','checkout.html','login.html',
           'demo-index.html','vault.html','admin-review.html')

$report = @()
foreach ($f in $files) {
  $path = Join-Path $dir $f
  if (-not (Test-Path $path)) { $report += "MISSING  $f"; continue }
  $txt = [System.IO.File]::ReadAllText($path)
  $orig = $txt
  foreach ($pair in $htmlPairs) { $txt = $txt.Replace($pair[0], $pair[1]) }
  foreach ($pair in $cssPairs)  { $txt = $txt.Replace($pair[0], $pair[1]) }
  $txt = $txt.Replace($loginOld, $loginNew)
  if ($txt -ne $orig) {
    [System.IO.File]::WriteAllText($path, $txt, $enc)
    $report += "UPDATED  $f"
  } else {
    $report += "no-change $f"
  }
}
[System.IO.File]::WriteAllText('C:\Users\Rupayan\Desktop\SaveHatke\cropinfo.txt', ($report -join "`r`n"))
