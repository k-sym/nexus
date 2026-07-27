import SwiftUI
import UIKit
import NexusCore

/// Centralizes the app's "attached / live" concept. Owns the single long-lived
/// approvals NDJSON stream (`GET /api/approvals/stream`): applies `snapshot`
/// then `pending`/`resolved`, ignores `\n` heartbeats, and publishes the
/// pending list + count (the Approvals tab badge). Holding the stream open is
/// what marks this client present server-side. Started/stopped by scene phase.
@MainActor
@Observable
final class LiveHub {
    private let api: APIClient
    private(set) var pending: [PendingApproval] = []
    private var streamTask: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    var pendingCount: Int { pending.count }

    /// Keep the app-icon badge in sync with the live pending count. Push sets
    /// the badge when a notification arrives, but resolves (allow/deny) don't
    /// push — so we clear/adjust it here as the live stream updates.
    private func syncBadge() {
        let count = pending.count
        Task { @MainActor in
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }

    func start() {
        guard streamTask == nil else { return }
        streamTask = Task { await run() }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func decide(_ approval: PendingApproval, action: String, reason: String? = nil) {
        pending.removeAll { $0.toolCallId == approval.toolCallId } // optimistic
        syncBadge()
        Task { try? await api.decideApproval(toolCallId: approval.toolCallId, action: action, reason: reason) }
    }

    private func run() async {
        while !Task.isCancelled {
            do {
                let stream = try await api.approvalsStream()
                for try await line in stream { apply(line) }
            } catch {
                // Transient drop; fall through to reconnect.
            }
            if Task.isCancelled { break }
            try? await Task.sleep(for: .seconds(3)) // reconnect; the next snapshot re-seeds
        }
    }

    private func apply(_ line: JSONValue) {
        guard let kind = line["kind"]?.string else { return } // heartbeat: bare "\n"
        defer { syncBadge() }
        switch kind {
        case "snapshot":
            pending = (line["approvals"]?.array ?? []).compactMap { PendingApproval(json: $0) }
        case "pending":
            if let approval = line["approval"].flatMap({ PendingApproval(json: $0) }),
               !pending.contains(where: { $0.toolCallId == approval.toolCallId }) {
                pending.append(approval)
            }
        case "resolved":
            if let id = line["toolCallId"]?.string {
                pending.removeAll { $0.toolCallId == id }
            }
        default:
            break
        }
    }
}
