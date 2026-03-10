Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded background #0d0d0d
    [float]$rad = $Size * 0.20
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc([float]0,                [float]0,                $rad*2, $rad*2, 180, 90)
    $path.AddArc([float]($Size-$rad*2),   [float]0,                $rad*2, $rad*2, 270, 90)
    $path.AddArc([float]($Size-$rad*2),   [float]($Size-$rad*2),   $rad*2, $rad*2,   0, 90)
    $path.AddArc([float]0,                [float]($Size-$rad*2),   $rad*2, $rad*2,  90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 13, 13, 13))), $path)
    $g.SetClip($path)

    $green = [System.Drawing.Color]::FromArgb(255, 80, 250, 123)

    if ($Size -ge 32) {
        [float]$thick = if ($Size -le 48) { $Size * 0.13 } else { $Size * 0.095 }
        $pen = New-Object System.Drawing.Pen($green, $thick)
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

        [float]$midX = $Size * 0.54
        [float]$midY = $Size * 0.50
        $g.DrawLine($pen, [float]($Size*0.14), [float]($Size*0.22), $midX, $midY)
        $g.DrawLine($pen, $midX, $midY, [float]($Size*0.14), [float]($Size*0.78))

        $cbBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 80, 250, 123))
        $g.FillRectangle($cbBrush,
            [float]($Size*0.60), [float]($Size*0.37),
            [float]($Size*0.17), [float]($Size*0.26))

        if ($Size -ge 128) {
            $scanPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(18, 80, 250, 123), 1.0)
            [int]$step = [Math]::Max(1, [int]($Size * 0.045))
            for ([int]$sy = 0; $sy -lt $Size; $sy += $step) {
                $g.DrawLine($scanPen, 0, $sy, $Size, $sy)
            }

            # Neural nodes
            [float]$n0x = $Size*0.75; [float]$n0y = $Size*0.72; [float]$n0r = $Size*0.055
            [float]$n1x = $Size*0.87; [float]$n1y = $Size*0.64; [float]$n1r = $Size*0.038
            [float]$n2x = $Size*0.89; [float]$n2y = $Size*0.81; [float]$n2r = $Size*0.044
            [float]$n3x = $Size*0.96; [float]$n3y = $Size*0.72; [float]$n3r = $Size*0.028

            $nodePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 80, 250, 123), ($Size * 0.013))
            $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90,  80, 250, 123), ($Size * 0.008))
            $g.DrawLine($linePen, $n0x, $n0y, $n1x, $n1y)
            $g.DrawLine($linePen, $n0x, $n0y, $n2x, $n2y)
            $g.DrawLine($linePen, $n1x, $n1y, $n3x, $n3y)
            $g.DrawLine($linePen, $n2x, $n2y, $n3x, $n3y)
            $g.DrawEllipse($nodePen, $n0x-$n0r, $n0y-$n0r, $n0r*2, $n0r*2)
            $g.DrawEllipse($nodePen, $n1x-$n1r, $n1y-$n1r, $n1r*2, $n1r*2)
            $g.DrawEllipse($nodePen, $n2x-$n2r, $n2y-$n2r, $n2r*2, $n2r*2)
            $g.DrawEllipse($nodePen, $n3x-$n3r, $n3y-$n3r, $n3r*2, $n3r*2)
        }
    } else {
        # 16x16 minimal chevron
        $pen2 = New-Object System.Drawing.Pen($green, 2.2)
        $pen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen2.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawLine($pen2, [float]3.5, [float]3.0,  [float]9.5, [float]8.0)
        $g.DrawLine($pen2, [float]9.5, [float]8.0,  [float]3.5, [float]13.0)
        $g.FillRectangle(
            (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 80, 250, 123))),
            [float]10, [float]5, [float]3, [float]6)
    }

    $g.Dispose()
    # Return bitmap wrapped so pipeline doesn't dispose/unroll it
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
    $pngs  = New-Object System.Collections.Generic.List[byte[]]
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

    [int]$count  = $pngs.Count
    $stream = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::Create)
    $bw     = New-Object System.IO.BinaryWriter($stream)

    # ICO header
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$count)

    # Directory entries
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

    # Image data
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
