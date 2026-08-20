import SwiftUI
import NexusCore

/// Outbound draft card on the Pulse dashboard (baker-internal#42) — replies the
/// partner has proposed but may not send.
///
/// This is the first Pulse card that *acts*, so it is deliberately stricter than
/// the routines card beside it:
///   * the card lists subjects only; Send lives inside the sheet, after the full
///     body has loaded — approving a preview is not consent;
///   * Send is a destructive-styled confirmation dialog, because a stray tap on a
///     phone must not put an email in a colleague's inbox;
///   * a failed send stays on screen as an error. It must never read as success.
///
/// The card hides itself when the queue is empty, which is the normal state.
@MainActor
@Observable
final class DraftsCardViewModel {
    private let api: APIClient
    var state: LoadState<DraftsResponse> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.drafts())
        } catch {
            state = .failed(LoadState<DraftsResponse>.message(for: error))
        }
    }
}

struct DraftsCard: View {
    private let api: APIClient
    @State private var vm: DraftsCardViewModel
    @State private var selected: OutboundDraft?

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: DraftsCardViewModel(api: api))
    }

    var body: some View {
        Group {
            if shouldRender {
                Card(title: "Drafts awaiting you", systemImage: "envelope.badge") {
                    content
                }
            }
        }
        .polling(PollingCadence.missionControl) { await vm.refresh() }
        .sheet(item: $selected) { draft in
            DraftReviewSheet(api: api, draft: draft) {
                Task { await vm.refresh() }
            }
        }
    }

    /// Stay invisible while idle, unconfigured, or empty — an empty queue is the
    /// normal state and does not deserve dashboard space.
    private var shouldRender: Bool {
        switch vm.state {
        case .idle, .loading: return false
        case .failed: return true
        case .loaded(let response):
            if response.configured == false { return false }
            return response.error != nil || !response.drafts.isEmpty
        }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            EmptyView()
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red)
        case .loaded(let response):
            if let error = response.error {
                Text("Adapter unreachable — \(error)")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(response.drafts) { draft in
                    Button { selected = draft } label: { DraftRow(draft: draft) }
                        .buttonStyle(.plain)
                }
            }
        }
    }
}

struct DraftRow: View {
    let draft: OutboundDraft

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: draft.isReply ? "arrowshape.turn.up.left" : "envelope")
                .font(.caption)
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(draft.subject)
                    .font(.subheadline)
                    .lineLimit(1)
                if let rationale = draft.rationale, !rationale.isEmpty {
                    Text(rationale)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Text(draft.account)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

/// Full-body review. Send is only reachable from here, and only after `detail`
/// has loaded.
struct DraftReviewSheet: View {
    private let api: APIClient
    private let draft: OutboundDraft
    private let onDecided: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var detail: OutboundDraftDetail?
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var result: String?
    @State private var confirmingSend = false
    @State private var busy = false

    init(api: APIClient, draft: OutboundDraft, onDecided: @escaping () -> Void) {
        self.api = api
        self.draft = draft
        self.onDecided = onDecided
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("From", value: draft.account)
                    if let replyTo = draft.replyTo {
                        LabeledContent("Reply to", value: replyTo)
                    } else if !draft.to.isEmpty {
                        LabeledContent("To", value: draft.to.joined(separator: ", "))
                    }
                    LabeledContent("Subject", value: draft.subject)
                    if let rationale = draft.rationale, !rationale.isEmpty {
                        LabeledContent("Why", value: rationale)
                    }
                }

                Section("Message") {
                    if let detail {
                        Text(detail.body)
                            .font(.callout)
                            .textSelection(.enabled)
                    } else if let loadError {
                        Text(loadError).font(.caption).foregroundStyle(.red)
                    } else {
                        ProgressView()
                    }
                }

                if let actionError {
                    Section {
                        Label(actionError, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                if let result {
                    Section {
                        Label(result, systemImage: "checkmark.circle")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }

                if detail != nil && result == nil {
                    Section {
                        Button {
                            confirmingSend = true
                        } label: {
                            Label("Send", systemImage: "paperplane.fill")
                        }
                        .disabled(busy)

                        Button(role: .destructive) {
                            Task { await decide(approve: false) }
                        } label: {
                            Label("Reject", systemImage: "trash")
                        }
                        .disabled(busy)
                    } footer: {
                        Text("Sending is immediate and cannot be undone.")
                    }
                }
            }
            .navigationTitle("Review draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Send this reply from \(draft.account)?",
                isPresented: $confirmingSend,
                titleVisibility: .visible
            ) {
                Button("Send now", role: .destructive) {
                    Task { await decide(approve: true) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            detail = try await api.draftDetail(id: draft.id)
        } catch {
            loadError = LoadState<OutboundDraftDetail>.message(for: error)
        }
    }

    private func decide(approve: Bool) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            if approve {
                let decision = try await api.approveDraft(id: draft.id)
                result = (decision.sent == true) ? "Sent." : "Approved."
            } else {
                _ = try await api.rejectDraft(id: draft.id)
                result = "Rejected — nothing sent."
            }
            onDecided()
        } catch {
            // Covers the 409 "already decided" case as well as a genuine send
            // failure. Either way the user is told, and `result` stays nil.
            actionError = LoadState<DraftDecision>.message(for: error)
        }
    }
}
