import SwiftUI
import NexusCore

/// One partner attention item as a list row (#477): kind glyph with a spoken
/// label, title, why, and the proposed verb as a capsule (or the item's state).
/// Used by the Assistant tab's "Needs you" section (design D17); tapping a row
/// presents `AttentionItemSheet`, where the item's verbs run. The row itself
/// renders no verb button — the partner's data guarantee ends where a client
/// invents one.
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
