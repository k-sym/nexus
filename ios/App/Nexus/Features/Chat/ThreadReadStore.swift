import SwiftUI
import NexusCore

/// Lightweight, client-side "read state" for chat threads.
///
/// The server model (`ChatThread`) has no unread flag — it only exposes
/// `updatedAt`. So we track the last `updatedAt` the user has *seen* per thread
/// in `UserDefaults`: a thread is "unread" when its current `updatedAt` is
/// newer than the last-seen value. Opening a thread marks it read.
///
/// This is intentionally simple (string compare on ISO-8601 timestamps, which
/// sort lexicographically) and needs no backend change.
@MainActor
@Observable
final class ThreadReadStore {
    private static let key = "thread.lastSeen.v1"
    /// threadId -> last-seen `updatedAt`
    private var lastSeen: [String: String]

    init() {
        lastSeen = (UserDefaults.standard.dictionary(forKey: Self.key) as? [String: String]) ?? [:]
    }

    /// True when the thread has changed since the user last opened it. Pure —
    /// safe to call from a view body. Threads we've never seen count as read
    /// (see `seed(_:)`), so a fresh install doesn't light up the whole list.
    func isUnread(_ thread: ChatThread) -> Bool {
        guard let seen = lastSeen[thread.id] else { return false }
        return thread.updatedAt > seen
    }

    /// Record baseline state for any threads we haven't seen before. Call once
    /// when a thread list loads (not from a view body). Existing threads become
    /// "read"; genuinely new activity after this point shows as unread.
    func seed(_ threads: [ChatThread]) {
        var changed = false
        for thread in threads where lastSeen[thread.id] == nil {
            lastSeen[thread.id] = thread.updatedAt
            changed = true
        }
        if changed { persist() }
    }

    /// Call when the user opens a thread (or it's otherwise "seen").
    func markRead(_ thread: ChatThread) {
        guard lastSeen[thread.id] != thread.updatedAt else { return }
        lastSeen[thread.id] = thread.updatedAt
        persist()
    }

    /// Count of unread threads in a list (drives higher-level badges).
    func unreadCount(in threads: [ChatThread]) -> Int {
        threads.reduce(0) { $0 + (isUnread($1) ? 1 : 0) }
    }

    private func persist() {
        UserDefaults.standard.set(lastSeen, forKey: Self.key)
    }
}
