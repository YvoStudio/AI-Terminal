Add-Type -AssemblyName System.Drawing
. "$PSScriptRoot\gen-icon.ps1" *>$null
New-IconBitmap 256
$script:_lastBmp.Save("$PSScriptRoot\..\src-tauri\icons\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$script:_lastBmp.Dispose()
Write-Host "icon.png updated"
