import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Renders the Nexus "connected nodes" app icon for iOS 26 Liquid Glass.
//
// Outputs three 1024x1024 layers into ./out :
//   AppIcon.png         — default (any/light): mark on dark charcoal
//   AppIcon-Dark.png    — dark appearance: mark on transparent (system glass)
//   AppIcon-Tinted.png  — tinted: monochrome mark on transparent
//
// For Liquid Glass the artwork stays flat & centered; the system supplies the
// depth, specular highlights and translucency. So we keep gradients subtle and
// leave generous padding, and never bake in our own rounded-rect mask.

let size = 1024.0
let cs = CGColorSpaceCreateDeviceRGB()

func makeCtx() -> CGContext {
    CGContext(data: nil, width: Int(size), height: Int(size),
              bitsPerComponent: 8, bytesPerRow: 0, space: cs,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(colorSpace: cs, components: [r/255, g/255, b/255, a])!
}

let blue   = rgb(10, 132, 255)
let blueLt = rgb(74, 163, 255)
let white  = rgb(255, 255, 255)

// Node layout (top-left origin; convert y for CG's bottom-left origin).
func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: size - y) }
let c = p(512, 512)
let outer: [CGPoint] = [
    p(512, 268), p(723, 390), p(723, 634),
    p(512, 756), p(301, 634), p(301, 390)
]

// Draws the connected-nodes mark. `mono` renders it in solid white (for the
// tinted variant, which the system recolors).
func drawMark(_ ctx: CGContext, mono: Bool) {
    // Edges
    ctx.setLineCap(.round)
    ctx.setLineWidth(26)
    ctx.setStrokeColor(mono ? rgb(255,255,255,0.9) : rgb(10,132,255,0.85))
    for o in outer { ctx.move(to: c); ctx.addLine(to: o); ctx.strokePath() }

    func node(_ pt: CGPoint, radius: Double) {
        if mono {
            ctx.setFillColor(white)
            ctx.addEllipse(in: CGRect(x: pt.x-radius, y: pt.y-radius, width: radius*2, height: radius*2))
            ctx.fillPath()
        } else {
            ctx.saveGState()
            ctx.addEllipse(in: CGRect(x: pt.x-radius, y: pt.y-radius, width: radius*2, height: radius*2))
            ctx.clip()
            let g = CGGradient(colorsSpace: cs, colors: [blueLt, blue] as CFArray, locations: [0,1])!
            ctx.drawLinearGradient(g,
                start: CGPoint(x: pt.x-radius, y: pt.y+radius),
                end:   CGPoint(x: pt.x+radius, y: pt.y-radius), options: [])
            ctx.restoreGState()
        }
    }
    for o in outer { node(o, radius: 66) }
    node(c, radius: 104)

    // White core on the center node (skip in mono so the whole mark is one shape)
    if !mono {
        ctx.setFillColor(white)
        ctx.addEllipse(in: CGRect(x: c.x-46, y: c.y-46, width: 92, height: 92))
        ctx.fillPath()
    }
}

func writePNG(_ ctx: CGContext, _ name: String) {
    let img = ctx.makeImage()!
    let url = URL(fileURLWithPath: "out/\(name)")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    print("Wrote out/\(name)")
}

try? FileManager.default.createDirectory(atPath: "out", withIntermediateDirectories: true)

// 1) Default / light: dark charcoal fill + subtle glow + mark.
do {
    let ctx = makeCtx()
    let bg = CGGradient(colorsSpace: cs, colors: [rgb(28,28,30), rgb(10,10,11)] as CFArray, locations: [0,1])!
    ctx.saveGState(); ctx.addRect(CGRect(x:0,y:0,width:size,height:size)); ctx.clip()
    ctx.drawLinearGradient(bg, start: CGPoint(x:0,y:size), end: CGPoint(x:0,y:0), options: [])
    ctx.restoreGState()
    let center = CGPoint(x: size/2, y: size/2)
    let glow = CGGradient(colorsSpace: cs, colors: [rgb(10,132,255,0.45), rgb(10,132,255,0)] as CFArray, locations: [0,1])!
    ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: 380, options: [])
    drawMark(ctx, mono: false)
    writePNG(ctx, "AppIcon.png")
}

// 2) Dark appearance: transparent background so the system glass shows through.
do {
    let ctx = makeCtx()
    // faint blue glow helps the mark read on the glass, but no opaque fill.
    let center = CGPoint(x: size/2, y: size/2)
    let glow = CGGradient(colorsSpace: cs, colors: [rgb(10,132,255,0.30), rgb(10,132,255,0)] as CFArray, locations: [0,1])!
    ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: 340, options: [])
    drawMark(ctx, mono: false)
    writePNG(ctx, "AppIcon-Dark.png")
}

// 3) Tinted: monochrome mark on transparent; the system applies the user tint.
do {
    let ctx = makeCtx()
    drawMark(ctx, mono: true)
    writePNG(ctx, "AppIcon-Tinted.png")
}
