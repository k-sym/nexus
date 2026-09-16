import SwiftUI
import NexusCore

/// "Needs you" card on the Pulse dashboard (#477): the partner's attention
/// items — what needs Keith, with the proposed next action and the verbs each
/// surface may offer written into the record.
///
/// The card owns no data. `LiveHub` polls the list at app level (the badge is
/// approvals + open items, and a count that lived only here would be zero on
/// every launch and stale off-tab); the card reads `liveHub.attention` and asks
/// it to refresh after a verb. It renders exactly the verbs an item lists, and
/// only while the item is `open` or `snoozed` — the partner stores `verbs` on
/// the item and never strips them, and answers 409 in any other state.
///
/// Hidden while idle, unconfigured, empty, or when the backend has no route at
/// all (an older backend: absent means hidden, per the intent).
struct AttentionCard: View {
    private let api: APIClient
    @Environment(LiveHub.self) private var liveHub
    @State private var selected: AttentionItem?
    @State private var quickError: String?

    init(api: APIClient) { self.api = api }

    var body: some View {
        // ZStack so the container exists while hidden (see DraftsCard).
        ZStack {
            if shouldRender {
                Card(title: "Needs you", systemImage: "bell.badge") {
                    content
                }
            }
        }
        .sheet(item: $selected) { item in
            AttentionItemSheet(api: api, itemId: item.id, seed: item) {
                Task { await liveHub.refreshAttention() }
            }
        }
    }

    private var shouldRender: Bool {
        if liveHub.attentionRouteMissing { return false }
        switch liveHub.attention {
        case .idle, .loading: return false
        case .failed: return true
        case .loaded(let response):
            if response.configured == false { return false }
            return response.error != nil || !response.items.isEmpty
        }
    }

    @ViewBuilder
    private var content: some View {
        switch liveHub.attention {
        case .idle, .loading:
            EmptyView()
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red)
        case .loaded(let response):
            if let error = response.error {
                Text("Adapter unreachable — \(error)")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(response.items) { item in
                    Button { selected = item } label: { AttentionRow(item: item) }
                        .buttonStyle(.plain)
                        .contextMenu { quickVerbs(for: item) }
                }
                if let quickError {
                    Label(quickError, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                }
            }
        }
    }

    /// Long-press shortcuts for the two verbs that need no context: snooze
    /// (tomorrow) and dismiss. Offered only when the item lists them and is in
    /// a state that accepts them. Everything else runs from the sheet.
    @ViewBuilder
    private func quickVerbs(for item: AttentionItem) -> some View {
        let offered = item.offeredVerbs
        if offered.contains(.snooze) {
            Button {
                Task { await quick(item, .snooze, preset: .tomorrow) }
            } label: { Label("Snooze until tomorrow", systemImage: "zzz") }
        }
        if offered.contains(.dismiss) {
            Button(role: .destructive) {
                Task { await quick(item, .dismiss) }
            } label: { Label("Dismiss", systemImage: "xmark.circle") }
        }
        if offered.isEmpty {
            Text(item.status == .resolving ? "Drafting…" : "No actions available")
        }
    }

    private func quick(_ item: AttentionItem, _ verb: AttentionVerb, preset: AttentionSnoozePreset? = nil) async {
        quickError = nil
        do {
            try await api.resolveAttention(id: item.id, verb: verb, preset: preset)
        } catch {
            quickError = LoadState<AttentionItem>.message(for: error)
        }
        await liveHub.refreshAttention()
    }
}

struct AttentionRow: View {
    let item: AttentionItem

    var body: some View {
        HStack(spacing: 8) {
            AttentionKindGlyph(kind: item.kind, kindName: item.kindName)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline)
                    .lineLimit(1)
                if let why = item.why, !why.isEmpty {
                    Text(why)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            trailing
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    /// The proposed next action as a capsule — a tap on the row opens the sheet
    /// where it runs. A resolving item shows its drafting state instead; a
    /// snoozed one, that it is snoozed.
    @ViewBuilder
    private var trailing: some View {
        switch item.status {
        case .resolving:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Drafting").font(.caption2).foregroundStyle(.secondary)
            }
        case .snoozed:
            Label("Snoozed", systemImage: "zzz")
                .font(.caption2).foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
        default:
            if let verb = item.proposedVerb, verb != .unknown, item.offeredVerbs.contains(verb) {
                Text("\(AttentionVerbLabel.title(verb))?")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Proposed: \(AttentionVerbLabel.title(verb))")
            }
        }
    }
}

/// Kind glyph with a spoken label (the `RoutineHealthBadge` pattern). An
/// unknown kind from a future producer renders as a bell, never as a failure.
struct AttentionKindGlyph: View {
    let kind: AttentionKind
    var kindName: String = ""

    var body: some View {
        Image(systemName: Self.symbol(for: kind))
            .font(.caption)
            .foregroundStyle(Self.color(for: kind))
            .frame(width: 18)
            .accessibilityLabel(Self.accessibilityLabel(for: kind, raw: kindName))
    }

    static func symbol(for kind: AttentionKind) -> String {
        switch kind {
        case .mailWaiting: "envelope"
        case .mailUrgent: "envelope.badge"
        case .draftPending: "paperplane"
        case .meetingPrep: "calendar"
        case .autonomyProposal: "arrow.up.circle"
        case .quizPrep, .quizHarvest: "music.mic"
        case .unknown: "bell"
        }
    }

    static func color(for kind: AttentionKind) -> Color {
        switch kind {
        case .mailWaiting, .draftPending: .blue
        case .mailUrgent: .orange
        case .meetingPrep: .purple
        case .autonomyProposal: .green
        case .quizPrep, .quizHarvest: .pink
        case .unknown: .secondary
        }
    }

    static func title(for kind: AttentionKind, raw: String = "") -> String {
        switch kind {
        case .mailWaiting: "Mail waiting"
        case .mailUrgent: "Urgent mail"
        case .draftPending: "Draft pending"
        case .meetingPrep: "Meeting prep"
        case .autonomyProposal: "Autonomy proposal"
        case .quizPrep: "Quiz prep"
        case .quizHarvest: "Quiz harvest"
        case .unknown: raw.isEmpty ? "Attention item" : raw
        }
    }

    static func accessibilityLabel(for kind: AttentionKind, raw: String) -> String {
        switch kind {
        case .mailWaiting: "waiting mail"
        case .mailUrgent: "urgent mail"
        case .draftPending: "a draft awaiting approval"
        case .meetingPrep: "meeting preparation"
        case .autonomyProposal: "an autonomy proposal"
        case .quizPrep: "quiz preparation"
        case .quizHarvest: "quiz harvest"
        case .unknown: raw.isEmpty ? "attention item" : "attention item of kind \(raw)"
        }
    }
}

/// Human labels for the partner's verbs. The wire value is the source of truth;
/// these only decorate it.
enum AttentionVerbLabel {
    static func title(_ verb: AttentionVerb) -> String {
        switch verb {
        case .draft: "Draft"
        case .open: "Open"
        case .snooze: "Snooze"
        case .dismiss: "Dismiss"
        case .unknown: "Unknown"
        }
    }
}
