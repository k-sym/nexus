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

/// Wrapper so an attention deep-link (#477) can drive a `sheet(item:)`. The
/// sheet loads the item by id, so a stale push still opens something honest.
struct AttentionRef: Identifiable, Hashable {
    let id: String
}

/// Shared navigation intent, driven by push-notification taps (and a DEBUG
/// hook). The shell binds its tab selection to `selectedTab`, presents
/// `openThread` as a cover and `openAttention` as a sheet.
@MainActor
@Observable
final class AppRouter {
    var selectedTab: String = "assistant"
    var openThread: OpenThread?
    var openAttention: AttentionRef?

    /// Parse a backend deep-link: `approval:<toolCallId>` | `thread:<threadId>` |
    /// `attention:<itemId>` | `open:`.
    func handle(deepLink: String) {
        let parts = deepLink.split(separator: ":", maxSplits: 1).map(String.init)
        switch parts.first {
        case "approval":
            selectedTab = "approvals"
        case "thread":
            if parts.count > 1, !parts[1].isEmpty { openThread = OpenThread(id: parts[1]) }
        case "attention":
            if parts.count > 1, !parts[1].isEmpty {
                // A view presents one modal at a time: an open thread cover
                // would swallow the sheet, so it is dismissed first.
                openThread = nil
                openAttention = AttentionRef(id: parts[1])
            }
        default:
            break
        }
    }
}
