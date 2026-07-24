import Foundation

/// Build-time configuration surfaced from Info.plist (which substitutes values
/// from the `.xcconfig` files at build time).
enum BuildConfig {
    /// Backend URL to prefill in the onboarding screen during development.
    /// Sourced from `DEV_BASE_URL` (set in `Local.xcconfig`) → Info.plist
    /// `DevBaseURL`. Only consulted in DEBUG builds; `nil`/empty in Release.
    static var devBaseURL: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "DevBaseURL") as? String,
              !value.isEmpty else { return nil }
        return value
    }
}
