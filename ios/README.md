# Nexus iOS

Native SwiftUI thin client for the Nexus backend. Like the desktop UI and the
G2 glasses, it holds a base URL + shared bearer token and drives the backend's
`/api/*` over Tailscale — all work runs on the server; the phone is a remote.

Full design + milestone plan: `~/.claude/plans/we-re-going-mobile-so-cozy-kitten.md`.

## Layout

```
ios/
  App/                 # the iOS app target
    Nexus.xcodeproj    # objectVersion 77, synchronized file-system groups
    Nexus/             # app sources (auto-included; add files, no pbxproj edits)
    Nexus.xcconfig     # shared build settings (bundle id it.resolve.nexus)
    Debug/Release.xcconfig
    Local.xcconfig.example  # copy → Local.xcconfig (git-ignored) for team + dev URL
  NexusCore/           # local Swift package: models, networking, streaming
                       # (no SwiftUI/UIKit — builds + tests headlessly on macOS)
```

## Build & test

```bash
# Pure logic — fast, no simulator, no tailnet:
cd ios/NexusCore && swift test

# The app, on a simulator:
cd ios/App
xcodebuild build -scheme Nexus \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build
```

## Signing / device builds

Simulator builds need no team. For a device or TestFlight, copy
`App/Local.xcconfig.example` → `App/Local.xcconfig` and set `DEVELOPMENT_TEAM`.
Optionally set `DEV_BASE_URL` there to prefill the onboarding screen in DEBUG.

## Connecting

Enter `https://<host>.ts.net:<port>` + the shared backend token. The token is
stored in the Keychain and sent as `Authorization: Bearer` on every `/api/*`
call except `/api/health`. The device must be on the tailnet (Tailscale iOS
app). The Simulator can't join the tailnet directly — point it at a
`tailscale serve` URL on the Mac or a LAN IP during development.
