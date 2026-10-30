param([Parameter(Mandatory = $true)][string]$EditedRoom)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
public static class DjRoomComposite {
    public static void Apply(Bitmap room, Bitmap edit) {
        for (int y = 0; y < 335; y++) for (int x = 0; x < 660; x++) {
            // Preserve the original dance floor, including its surrounding frame.
            if (x >= 474 && y >= 270) continue;
            double alpha = Math.Min(1, Math.Min((660.0-x)/40, (335.0-y)/25));
            Color original = room.GetPixel(x,y), changed = edit.GetPixel(x,y);
            room.SetPixel(x,y,Color.FromArgb(255,
                (int)Math.Round(original.R*(1-alpha)+changed.R*alpha),
                (int)Math.Round(original.G*(1-alpha)+changed.G*alpha),
                (int)Math.Round(original.B*(1-alpha)+changed.B*alpha)));
        }
    }
}
'@
$assets = Join-Path $PSScriptRoot '..\public\images'
$original = [System.Drawing.Bitmap]::new((Join-Path $assets 'disco-background.png'))
$edit = [System.Drawing.Bitmap]::new($EditedRoom)
$room = [System.Drawing.Bitmap]::new($original)
$backgrounds = [System.Drawing.Bitmap]::new(3072, 1024)
$overlays = [System.Drawing.Bitmap]::new(3072, 1024)
$backgroundGraphics = [System.Drawing.Graphics]::FromImage($backgrounds)
$overlayGraphics = [System.Drawing.Graphics]::FromImage($overlays)
try {
    # Import only the AI-edited DJ area. All other source pixels, including bar and dance floor, stay exact.
    [DjRoomComposite]::Apply($room, $edit)
    $room.Save((Join-Path $assets 'disco-dj-background.png'), [System.Drawing.Imaging.ImageFormat]::Png)

    $booth = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $points = @(@(148,132),@(458,132),@(460,189),@(487,193),@(497,216),@(497,242),
        @(479,269),@(445,288),@(400,301),@(210,302),@(167,295),@(136,278),
        @(121,253),@(121,222),@(132,200),@(148,193))
    $booth.AddPolygon([System.Drawing.Point[]]@($points | ForEach-Object { [System.Drawing.Point]::new($_[0], $_[1]) }))
    $backgroundGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $overlayGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    for ($index = 0; $index -lt 8; $index++) {
        $frame = [System.Drawing.Bitmap]::new($room)
        $graphics = [System.Drawing.Graphics]::FromImage($frame)
        $foreground = [System.Drawing.Bitmap]::new(1536, 1024)
        $foregroundGraphics = [System.Drawing.Graphics]::FromImage($foreground)
        try {
            $phase = [math]::Floor($index / 2)
            if ($phase -gt 0) {
                $angle = $phase * [math]::PI / 2
                $cos = [math]::Cos($angle); $sin = [math]::Sin($angle) / [math]::Sqrt(3); $third = (1 - $cos) / 3
                $matrix = [System.Drawing.Imaging.ColorMatrix]::new()
                $matrix.Matrix00 = $cos + $third; $matrix.Matrix01 = $third + $sin; $matrix.Matrix02 = $third - $sin
                $matrix.Matrix10 = $third - $sin; $matrix.Matrix11 = $cos + $third; $matrix.Matrix12 = $third + $sin
                $matrix.Matrix20 = $third + $sin; $matrix.Matrix21 = $third - $sin; $matrix.Matrix22 = $cos + $third
                $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
                $attributes.SetColorMatrix($matrix)
                $graphics.DrawImage($room, [System.Drawing.Rectangle]::new(486,282,572,452), 486,282,572,452,
                    [System.Drawing.GraphicsUnit]::Pixel, $attributes)
                $attributes.Dispose()
            }
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            # The tonearms and equipment stay fixed. Labels and small groove markings turn at 45 RPM.
            foreach ($center in @(@(213,175), @(402,175))) {
                $state = $graphics.Save()
                $graphics.TranslateTransform($center[0], $center[1])
                $graphics.RotateTransform($index * 45)
                $labelMark = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220,255,245,221))
                $grooveMark = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(125,220,226,245), 2)
                $graphics.FillRectangle($labelMark, 5, -3, 5, 4)
                $graphics.DrawArc($grooveMark, -28,-28,56,56,15,25)
                $labelMark.Dispose(); $grooveMark.Dispose()
                $graphics.Restore($state)
            }
            # Full-canvas transparent overlay retains the exact alignment and whitespace.
            $foregroundGraphics.SetClip($booth)
            $foregroundGraphics.DrawImageUnscaled($frame, 0, 0)
            $target = [System.Drawing.Rectangle]::new(($index % 4) * 768, [math]::Floor($index / 4) * 512, 768, 512)
            $backgroundGraphics.DrawImage($frame, $target)
            $overlayGraphics.DrawImage($foreground, $target)
        } finally {
            $graphics.Dispose(); $foregroundGraphics.Dispose(); $frame.Dispose(); $foreground.Dispose()
        }
    }
    $booth.Dispose()
    $backgrounds.Save((Join-Path $assets 'disco-dj-spritesheet.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $overlays.Save((Join-Path $assets 'disco-dj-overlay-spritesheet.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $backgroundGraphics.Dispose(); $overlayGraphics.Dispose()
    $original.Dispose(); $edit.Dispose(); $room.Dispose(); $backgrounds.Dispose(); $overlays.Dispose()
}
