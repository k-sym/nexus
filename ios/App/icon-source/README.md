# App icon source (iOS 26 Liquid Glass)

`RenderIcon.swift` deterministically renders the Nexus app icon — a connected
"nexus" node network in the app's system-blue accent — at 1024×1024 using
CoreGraphics (no external tools/fonts needed).

It emits three layers into `out/` for the iOS 26 Liquid Glass layered icon:

| File | Appearance | Notes |
|------|------------|-------|
| `AppIcon.png`        | any / light | Blue mark on dark charcoal + glow |
| `AppIcon-Dark.png`   | dark        | Mark on **transparent** bg; system supplies the glass |
| `AppIcon-Tinted.png` | tinted      | Monochrome mark on transparent; system recolors it |

Liquid Glass note: keep the artwork flat, centered, well-padded, and **never**
bake in a rounded-rect mask or hard drop shadow — the system provides depth,
translucency and specular highlights.

## Regenerate

```sh
cd ios/App/icon-source
swift RenderIcon.swift          # writes out/AppIcon*.png
cp out/AppIcon.png         ../Nexus/Assets.xcassets/AppIcon.appiconset/AppIcon.png
cp out/AppIcon-Dark.png    ../Nexus/Assets.xcassets/AppIcon.appiconset/AppIcon-Dark.png
cp out/AppIcon-Tinted.png  ../Nexus/Assets.xcassets/AppIcon.appiconset/AppIcon-Tinted.png
```

The appiconset uses a single 1024×1024 icon per appearance; Xcode's `actool`
derives every runtime size (home screen, Settings, Spotlight, notification)
from them. Build setting `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` lives
in `Nexus.xcconfig`.

> On iOS the notification icon is always the app icon — there's no separate
> notification asset (unlike Android).
