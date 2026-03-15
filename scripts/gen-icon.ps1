Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background - dark terminal theme
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 30, 46))

    # Round rectangle background
    $cornerRadius = [int]($Size * 0.18)
    $sz = $Size - 1
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $cornerRadius * 2

    # Add arcs for rounded corners
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)  # Top-left
    $path.AddArc($sz - $diameter, 0, $diameter, $diameter, 270, 90)  # Top-right
    $path.AddArc($sz - $diameter, $sz - $diameter, $diameter, $diameter, 0, 90)  # Bottom-right
    $path.AddArc(0, $sz - $diameter, $diameter, $diameter, 90, 90)  # Bottom-left
    $path.CloseFigure()
    $g.FillPath($bgBrush, $path)

    $green = [System.Drawing.Color]::FromArgb(255, 80, 250, 123)
    $white = [System.Drawing.Color]::FromArgb(255, 248, 248, 242)

    if ($Size -ge 64) {
        # Terminal prompt symbol ">"
        [float]$promptX = $Size * 0.15
        [float]$promptY = $Size * 0.35
        [float]$promptW = $Size * 0.25
        [float]$promptH = $Size * 0.30
        [float]$strokeWidth = $Size * 0.055

        $pen = New-Object System.Drawing.Pen($green, $strokeWidth)
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

        # Draw ">" symbol
        $g.DrawLine($pen, $promptX, $promptY, $promptX + $promptW, $promptY + $promptH / 2)
        $g.DrawLine($pen, $promptX, $promptY + $promptH, $promptX + $promptW, $promptY + $promptH / 2)

        # Cursor block
        [float]$cursorX = $Size * 0.45
        [float]$cursorY = $Size * 0.32
        [float]$cursorW = $Size * 0.08
        [float]$cursorH = $Size * 0.36
        $cursorBrush = New-Object System.Drawing.SolidBrush($green)
        $g.FillRectangle($cursorBrush, $cursorX, $cursorY, $cursorW, $cursorH)

        # Terminal output lines
        [float]$lineStartX = $Size * 0.15
        [float]$line1Y = $Size * 0.55
        [float]$line2Y = $Size * 0.68
        [float]$lineWidth = $Size * 0.55
        [float]$lineHeight = $Size * 0.05
        $lineBrush = New-Object System.Drawing.SolidBrush($white)
        $g.FillRectangle($lineBrush, $lineStartX, $line1Y, $lineWidth, $lineHeight)
        $g.FillRectangle($lineBrush, $lineStartX, $line2Y, $lineWidth * 0.7, $lineHeight)

        # Input line indicator
        [float]$inputLineY = $Size * 0.82
        [float]$inputLineWidth = $Size * 0.45
        $inputBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 80, 250, 123))
        $g.FillRectangle($inputBrush, $lineStartX, $inputLineY, $inputLineWidth, $lineHeight)

    } elseif ($Size -ge 32) {
        # Simplified design for medium sizes
        [float]$promptX = $Size * 0.12
        [float]$promptY = $Size * 0.28
        [float]$promptW = $Size * 0.28
        [float]$promptH = $Size * 0.35
        [float]$strokeWidth = $Size * 0.065

        $pen = New-Object System.Drawing.Pen($green, $strokeWidth)
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

        # Draw ">" symbol
        $g.DrawLine($pen, $promptX, $promptY, $promptX + $promptW, $promptY + $promptH / 2)
        $g.DrawLine($pen, $promptX, $promptY + $promptH, $promptX + $promptW, $promptY + $promptH / 2)

        # Cursor
        [float]$cursorX = $Size * 0.48
        [float]$cursorY = $Size * 0.28
        [float]$cursorW = $Size * 0.10
        [float]$cursorH = $Size * 0.40
        $cursorBrush = New-Object System.Drawing.SolidBrush($green)
        $g.FillRectangle($cursorBrush, $cursorX, $cursorY, $cursorW, $cursorH)

        # Single output line
        [float]$lineY = $Size * 0.62
        [float]$lineWidth = $Size * 0.55
        [float]$lineHeight = $Size * 0.08
        $lineBrush = New-Object System.Drawing.SolidBrush($white)
        $g.FillRectangle($lineBrush, $promptX, $lineY, $lineWidth, $lineHeight)

    } else {
        # Minimal design for 16px
        [float]$promptX = 2.0
        [float]$promptY = 3.0
        [float]$strokeWidth = 2.5

        $pen = New-Object System.Drawing.Pen($green, $strokeWidth)
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

        # Draw ">" symbol
        $g.DrawLine($pen, $promptX, $promptY, $promptX + 4, $promptY + 4)
        $g.DrawLine($pen, $promptX, $promptY + 8, $promptX + 4, $promptY + 4)

        # Cursor block
        $cursorBrush = New-Object System.Drawing.SolidBrush($green)
        $g.FillRectangle($cursorBrush, 7.5, 3.5, 2.5, 7)

        # Tiny line
        $lineBrush = New-Object System.Drawing.SolidBrush($white)
        $g.FillRectangle($lineBrush, 11, 9, 4, 2)
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
