// Run with swift tests/macos-brand.swift "/path/to/Skill Library.app".
import AppKit

func require(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        exit(1)
    }
}

guard CommandLine.arguments.count == 2, let bundle = Bundle(path: CommandLine.arguments[1]),
      let iconName = bundle.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
      let iconURL = bundle.url(forResource: iconName, withExtension: nil),
      let image = NSImage(contentsOf: iconURL) else {
    fatalError("Expected a built macOS app with a readable bundle icon")
}
for key in ["CFBundleName", "CFBundleDisplayName"] {
    require(bundle.object(forInfoDictionaryKey: key) as? String == "Skill Library", "Unexpected \(key)")
}

// Verify the Obsidian Cartridge silhouette at 128px (1/8 scale of 1024px).
let size = 128
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()

func pixel(_ x: Int, _ y: Int) -> NSColor {
    bitmap.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
}

let topLeft = pixel(4, 4)
let bottomRight = pixel(123, 123)
require(topLeft.alphaComponent < 0.05 && bottomRight.alphaComponent < 0.05,
        "Expected transparent outer corners")

for (x, y) in [(22, 64), (106, 64)] {
    let margin = pixel(x, y)
    require(margin.alphaComponent > 0.9 && margin.redComponent < 0.30
            && margin.greenComponent < 0.30 && margin.blueComponent < 0.30,
            "Expected dark obsidian squircle margins at (\(x), \(y))")
}

let frontBody = pixel(64, 68)
require(frontBody.alphaComponent > 0.9 && frontBody.redComponent > 0.85
        && frontBody.greenComponent > 0.85 && frontBody.blueComponent > 0.85,
        "Expected bright machined front cartridge body")

let outsideChamfer = pixel(93, 42)
let insideChamfer = pixel(93, 64)
require(outsideChamfer.redComponent < 0.35 && outsideChamfer.greenComponent < 0.35
        && outsideChamfer.blueComponent < 0.35,
        "Expected dark background outside top-right 45-degree chamfer")
require(insideChamfer.redComponent > 0.85 && insideChamfer.greenComponent > 0.85
        && insideChamfer.blueComponent > 0.85,
        "Expected bright cartridge below top-right 45-degree chamfer")

let slot = pixel(54, 53)
require(slot.alphaComponent > 0.9 && slot.redComponent < 0.25
        && slot.greenComponent < 0.25 && slot.blueComponent < 0.25,
        "Expected upper dark mechanical slot")

let orangeKey = pixel(73, 53)
require(orangeKey.alphaComponent > 0.9 && orangeKey.redComponent > 0.80
        && orangeKey.greenComponent > 0.20 && orangeKey.greenComponent < 0.55
        && orangeKey.blueComponent < 0.30,
        "Expected Dieter Rams vermilion-orange key")

print("Verified bundle names and obsidian cartridge silhouette at 128px")
