Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 26, 46))
    $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)

    $green = [System.Drawing.Color]::FromArgb(255, 80, 250, 123)
    $lightGreen = [System.Drawing.Color]::FromArgb(230, 80, 250, 123)

    if ($Size -ge 32) {
        [float]$thick = if ($Size -le 48) { $Size * 0.22 } else { $Size * 0.18 }
        $greenBrush = New-Object System.Drawing.SolidBrush($green)

        [float]$midX = $Size * 0.70
        [float]$midY = $Size * 0.50
        [float]$startX = $Size * 0.02
        [float]$endY = $Size * 0.95
        [float]$y1 = $Size * 0.05

        for ($i = 0; $i -le 20; $i++) {
            [float]$t = $i / 20.0
            [float]$x = $startX + ($midX - $startX) * $t
            [float]$y = $y1 + ($midY - $y1) * $t
            $g.FillEllipse($greenBrush, $x - $thick/2, $y - $thick/2, $thick, $thick)
        }

        for ($i = 0; $i -le 20; $i++) {
            [float]$t = $i / 20.0
            [float]$x = $midX + ($startX - $midX) * $t
            [float]$y = $midY + ($endY - $midY) * $t
            $g.FillEllipse($greenBrush, $x - $thick/2, $y - $thick/2, $thick, $thick)
        }

        [float]$cbX = $Size * 0.72
        [float]$cbY = $Size * 0.22
        [float]$cbW = $Size * 0.26
        [float]$cbH = $Size * 0.52
        $cbBrush = New-Object System.Drawing.SolidBrush($lightGreen)
        $g.FillRectangle($cbBrush, $cbX, $cbY, $cbW, $cbH)

        if ($Size -ge 128) {
            $scanBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(18, 80, 250, 123))
            [int]$step = [Math]::Max(1, [int]($Size * 0.045))
            for ([int]$sy = 0; $sy -lt $Size; $sy += $step) {
                $g.FillRectangle($scanBrush, 0, $sy, $Size, 1)
            }

            [float]$n0x = $Size*0.82; [float]$n0y = $Size*0.70; [float]$n0r = $Size*0.07
            [float]$n1x = $Size*0.92; [float]$n1y = $Size*0.55; [float]$n1r = $Size*0.05
            [float]$n2x = $Size*0.94; [float]$n2y = $Size*0.78; [float]$n2r = $Size*0.055
            [float]$n3x = $Size*0.98; [float]$n3y = $Size*0.66; [float]$n3r = $Size*0.04

            $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 80, 250, 123))
            [float]$lineThick = $Size * 0.008
            for ($i = 0; $i -le 15; $i++) {
                [float]$t = $i / 15.0
                $g.FillEllipse($lineBrush, $n0x + ($n1x-$n0x)*$t - $lineThick/2, $n0y + ($n1y-$n0y)*$t - $lineThick/2, $lineThick, $lineThick)
                $g.FillEllipse($lineBrush, $n0x + ($n2x-$n0x)*$t - $lineThick/2, $n0y + ($n2y-$n0y)*$t - $lineThick/2, $lineThick, $lineThick)
                $g.FillEllipse($lineBrush, $n1x + ($n3x-$n1x)*$t - $lineThick/2, $n1y + ($n3y-$n1y)*$t - $lineThick/2, $lineThick, $lineThick)
                $g.FillEllipse($lineBrush, $n2x + ($n3x-$n2x)*$t - $lineThick/2, $n2y + ($n3y-$n2y)*$t - $lineThick/2, $lineThick, $lineThick)
            }

            $ringBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 80, 250, 123))
            $g.FillEllipse($ringBrush, $n0x-$n0r, $n0y-$n0r, $n0r*2, $n0r*2)
            $g.FillEllipse($ringBrush, $n1x-$n1r, $n1y-$n1r, $n1r*2, $n1r*2)
            $g.FillEllipse($ringBrush, $n2x-$n2r, $n2y-$n2r, $n2r*2, $n2r*2)
            $g.FillEllipse($ringBrush, $n3x-$n3r, $n3y-$n3r, $n3r*2, $n3r*2)
        }
    } else {
        [float]$thick = 3.0
        $penBrush = New-Object System.Drawing.SolidBrush($green)

        for ($i = 0; $i -le 10; $i++) {
            [float]$t = $i / 10.0
            [float]$x = 1.5 + (11.0 - 1.5) * $t
            [float]$y = 1.0 + (8.0 - 1.0) * $t
            $g.FillEllipse($penBrush, $x - $thick/2, $y - $thick/2, $thick, $thick)
        }
        for ($i = 0; $i -le 10; $i++) {
            [float]$t = $i / 10.0
            [float]$x = 11.0 + (1.5 - 11.0) * $t
            [float]$y = 8.0 + (15.0 - 8.0) * $t
            $g.FillEllipse($penBrush, $x - $thick/2, $y - $thick/2, $thick, $thick)
        }

        $cbBrush = New-Object System.Drawing.SolidBrush($lightGreen)
        $g.FillRectangle($cbBrush, 11.5, 4.0, 4.0, 8.0)
    }

    $g.Dispose()
    $script:_lastBmp = $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [byte[]]$bytes = $ms.ToArray()
    $ms.Dispose()
    $script:_lastPng = $bytes
}

function Write-Ico([string]$OutPath, [int[]]$Sizes) {
    $pngs = New-Object System.Collections.Generic.List[byte[]]
    $szList = New-Object System.Collections.Generic.List[int]

    foreach ($sz in $Sizes) {
        Write-Host "  Rendering ${sz}x${sz}..."
        New-IconBitmap $sz
        [System.Drawing.Bitmap]$bmp = $script:_lastBmp

        Get-PngBytes $bmp
        [byte[]]$png = $script:_lastPng
        $bmp.Dispose()

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
Write-Ico $outPath @(256, 128, 64, 48, 32, 16)
