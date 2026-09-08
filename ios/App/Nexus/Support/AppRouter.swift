import SwiftUI

/// A first turn to send as soon as a chat opens (ticket to session, #432):
/// the server-composed prompt and the model the user picked.
struct ChatSeed: Hashable {
    let text: String
    let modelKey: String?
}

/// Wrapper so a thread deep-link can drive a `fullScreenCover(item:)`.
struct OpenThread: Identifiable, Hashable {
    let id: String
    var title: String = "Chat"
    /// Sent once after history loads; nil for a plain open.
    var seed: ChatSeed? = nil
}

/// Shared navigation intent, driven by push-notification taps (and a DEBUG
/// hook). The shell binds its tab selection to `selectedTab` and presents
/// `openThread` as a cover.
@MainActor
@Observable
final class AppRouter {
    var selectedTab: String = "assistant"
    var openThread: OpenThread?

    /// Parse a backend deep-link: `approval:<toolCallId>` | `thread:<threadId>` | `open:`.
    func handle(deepLink: String) {
        let parts = deepLink.split(separator: ":", maxSplits: 1).map(String.init)
        switch parts.first {
        case "approval":
            selectedTab = "approvals"
        case "thread":
            if parts.count > 1, !parts[1].isEmpty { openThread = OpenThread(id: parts[1]) }
        default:
            break
        }
    }
}
