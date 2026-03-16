Add-Type -AssemblyName System.Drawing

$originalPath = Join-Path $PSScriptRoot '..\src-tauri\icons\icon-source.png'
$original = [System.Drawing.Image]::FromFile($originalPath)

function Get-PngBytes([int]$Size, [System.Drawing.Image]$src) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    
    # 绘制圆角背景
    $cornerRadius = [int]($Size * 0.18)
    $sz = $Size - 1
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $cornerRadius * 2
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($sz - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($sz - $diameter, $sz - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $sz - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    
    # 创建剪切区域
    $g.SetClip($path, [System.Drawing.Drawing2D.CombineMode]::Replace)
    $g.DrawImage($src, 0, 0, $Size, $Size)
    
    $g.Dispose()
    $path.Dispose()
    
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [byte[]]$bytes = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
    return $bytes
}

function Write-Ico([string]$OutPath, [int[]]$Sizes, [System.Drawing.Image]$src) {
    $pngs = New-Object System.Collections.Generic.List[byte[]]
    $szList = New-Object System.Collections.Generic.List[int]

    foreach ($sz in $Sizes) {
        Write-Host "  Rendering ${sz}x${sz}..."
        [byte[]]$png = Get-PngBytes $sz $src
        Write-Host "    PNG size: $($png.Length) bytes"
        $pngs.Add($png)
        $szList.Add($sz)
    }

    [int]$count = $pngs.Count
    $stream = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::Create)
    $bw = New-Object System.IO.BinaryWriter($stream)

    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$count)

    [int]$offset = 6 + $count * 16
    for ([int]$i = 0; $i -lt $count; $i++) {
        [int]$sz = $szList[$i]
        [byte]$bsz = if ($sz -eq 256) { 0 } else { [byte]$sz }
        [byte[]]$png = $pngs[$i]
        $bw.Write($bsz)
        $bw.Write($bsz)
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$png.Length)
        $bw.Write([uint32]$offset)
        $offset += $png.Length
    }

    for ([int]$i = 0; $i -lt $count; $i++) {
        [byte[]]$png = $pngs[$i]
        $bw.Write($png, 0, $png.Length)
    }

    $bw.Close()
    $stream.Close()
    $fileSize = (Get-Item $OutPath).Length
    Write-Host "ICO written: $OutPath ($fileSize bytes)"
}

$outPath = Join-Path $PSScriptRoot '..\src-tauri\icons\icon.ico'
Write-Host "Generating AI Terminal icon..."
Write-Ico $outPath @(256, 128, 64, 48, 32, 16) $original
$original.Dispose()
