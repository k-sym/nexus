import SwiftUI
import UIKit
import NexusCore

/// Centralizes the app's "attached / live" concept. Owns the single long-lived
/// approvals NDJSON stream (`GET /api/approvals/stream`): applies `snapshot`
/// then `pending`/`resolved`, ignores `\n` heartbeats, and publishes the
/// pending list + count (the Approvals tab badge). Holding the stream open is
/// what marks this client present server-side. Started/stopped by scene phase.
///
/// Also owns the partner attention list (#477) — polled here, at app level, and
/// not in the Pulse card, because the app-icon badge is approvals + open
/// attention items and a count that lives in a tab-scoped view model is zero
/// on every launch and stale whenever Pulse is not on screen. The first
/// approvals `snapshot` used to set the badge to approvals alone, wiping the
/// server's number; summing both halves here is what stops that.
@MainActor
@Observable
final class LiveHub {
    private let api: APIClient
    private(set) var pending: [PendingApproval] = []
    private var streamTask: Task<Void, Never>?

    /// The attention collection as last fetched. `.idle` until the first poll.
    private(set) var attention: LoadState<AttentionResponse> = .idle
    /// True when the backend answered 404 for `/api/attention` — an older
    /// backend without the route. The intent's rule: absent means hidden, so
    /// the card never renders an error for this.
    private(set) var attentionRouteMissing = false
    private var attentionTask: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    var pendingCount: Int { pending.count }

    /// Open *actions* — a notice never counts (design D22a) — or 0 while
    /// unknown/unconfigured/unreachable. Counted from the live list so the
    /// category is honoured; the partner's store-wide `open` cannot tell them apart.
    var attentionOpen: Int {
        guard case .loaded(let response) = attention, response.configured != false, response.error == nil else { return 0 }
        return response.items.filter { $0.status == .open && !$0.isNotice }.count
    }

    /// Live notices (seen-or-file items), for the section header.
    var attentionNotices: Int {
        attention.value?.items.filter { $0.isNotice }.count ?? 0
    }

    /// Items the Pulse card shows: the `live` list (open + snoozed + resolving).
    var attentionItems: [AttentionItem] { attention.value?.items ?? [] }

    /// Keep the app-icon badge in sync: pending approvals + open attention
    /// items, the same sum the server puts on every push. Push sets the badge
    /// when a notification arrives, but resolves (allow/deny, snooze/dismiss)
    /// don't push — so we clear/adjust it here as the live data updates.
    private func syncBadge() {
        let count = pending.count + attentionOpen
        Task { @MainActor in
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }

    func start() {
        if streamTask == nil { streamTask = Task { await run() } }
        if attentionTask == nil { attentionTask = Task { await pollAttention() } }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        attentionTask?.cancel()
        attentionTask = nil
    }

    /// Re-read the attention list now — after a verb from the card or sheet,
    /// or a deep-link open. Never throws; failures land in `attention`.
    func refreshAttention() async {
        if attention.value == nil, !attentionRouteMissing { attention = .loading }
        do {
            let response = try await api.attention()
            attentionRouteMissing = false
            attention = .loaded(response)
        } catch APIError.server(let status, _) where status == 404 {
            attentionRouteMissing = true
            attention = .idle
        } catch is CancellationError {
            return
        } catch {
            attention = .failed(LoadState<AttentionResponse>.message(for: error))
        }
        syncBadge()
    }

    private func pollAttention() async {
        while !Task.isCancelled {
            await refreshAttention()
            do { try await Task.sleep(for: PollingCadence.missionControl) } catch { return }
        }
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
