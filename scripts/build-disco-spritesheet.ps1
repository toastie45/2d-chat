# Build four lighting phases from one fixed scene. No furniture or camera position changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = Join-Path $PSScriptRoot '..\public\images'
$source = [System.Drawing.Bitmap]::new((Join-Path $assetDirectory 'disco-background.png'))
$sheet = [System.Drawing.Bitmap]::new($source.Width * 2, $source.Height * 2)
$graphics = [System.Drawing.Graphics]::FromImage($sheet)
try {
    for ($frame = 0; $frame -lt 4; $frame++) {
        $left = ($frame % 2) * $source.Width
        $top = [math]::Floor($frame / 2) * $source.Height
        $graphics.DrawImageUnscaled($source, $left, $top)
        if ($frame -eq 0) { continue }

        # Rotate the RGB color axes only inside the illuminated dance floor.
        # Neutral grout and the original light/dark texture remain in the same pixels.
        $angle = $frame * [math]::PI / 2
        $cos = [math]::Cos($angle)
        $sin = [math]::Sin($angle) / [math]::Sqrt(3)
        $third = (1 - $cos) / 3
        $matrix = [System.Drawing.Imaging.ColorMatrix]::new()
        $matrix.Matrix00 = $cos + $third
        $matrix.Matrix01 = $third + $sin
        $matrix.Matrix02 = $third - $sin
        $matrix.Matrix10 = $third - $sin
        $matrix.Matrix11 = $cos + $third
        $matrix.Matrix12 = $third + $sin
        $matrix.Matrix20 = $third + $sin
        $matrix.Matrix21 = $third - $sin
        $matrix.Matrix22 = $cos + $third
        $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
        try {
            $attributes.SetColorMatrix($matrix)
            $destination = [System.Drawing.Rectangle]::new($left + 486, $top + 282, 572, 452)
            $graphics.DrawImage($source, $destination, 486, 282, 572, 452,
                [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } finally { $attributes.Dispose() }
    }
    $sheet.Save((Join-Path $assetDirectory 'disco-background-spritesheet.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $sheet.Dispose()
    $source.Dispose()
}
