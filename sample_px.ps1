Add-Type -AssemblyName System.Drawing
$src = 'C:\Users\Rupayan\Desktop\SaveHatke\public\logo-icon.png'
$img = New-Object System.Drawing.Bitmap ([System.Drawing.Bitmap]::FromFile($src))

$pts = @(
  @(5,5,'corner'),
  @(350,25,'smoke-top'),
  @(80,300,'smoke-left'),
  @(660,500,'smoke-botright'),
  @(300,150,'icon-green'),
  @(400,360,'icon-blue'),
  @(545,90,'tag-ring-white'),
  @(150,290,'green-speedline')
)

$lines = @()
foreach ($p in $pts) {
  $c = $img.GetPixel([int]$p[0], [int]$p[1])
  $r=$c.R; $g=$c.G; $b=$c.B; $a=$c.A
  $max=[Math]::Max($r,[Math]::Max($g,$b)); $min=[Math]::Min($r,[Math]::Min($g,$b))
  $bri=[Math]::Round($max/255.0,2)
  $sat= if($max -eq 0){0}else{[Math]::Round(($max-$min)/[double]$max,2)}
  $lines += ("{0,-16} A={1,3} RGB=({2,3},{3,3},{4,3}) bri={5} sat={6}" -f $p[2],$a,$r,$g,$b,$bri,$sat)
}
$img.Dispose()
[System.IO.File]::WriteAllText('C:\Users\Rupayan\Desktop\SaveHatke\pixinfo.txt', ($lines -join "`r`n"))
