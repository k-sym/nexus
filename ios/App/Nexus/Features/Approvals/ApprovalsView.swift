import SwiftUI
import NexusCore

/// Live tool-gate queue. Each row is a pending approval streamed from the
/// backend; Allow/Deny posts a decision (optimistically removed from the list).
struct ApprovalsView: View {
    @Environment(LiveHub.self) private var liveHub

    var body: some View {
        Group {
            if liveHub.pending.isEmpty {
                ContentUnavailableView {
                    Label("No pending approvals", systemImage: "checkmark.shield")
                } description: {
                    Text("Tool gates awaiting your decision appear here in real time.")
                }
            } else {
                List(liveHub.pending) { approval in
                    ApprovalRow(
                        approval: approval,
                        onAllow: { liveHub.decide(approval, action: "allow") },
                        onDeny: { liveHub.decide(approval, action: "deny") })
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Approvals")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Liquid Glass count pill mirroring the tab badge.
                GlassBadge(count: liveHub.pendingCount)
            }
        }
    }
}

struct ApprovalRow: View {
    let approval: PendingApproval
    let onAllow: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundStyle(tint)
                Text(approval.toolName).font(.subheadline.weight(.semibold))
                if !approval.category.isEmpty {
                    Text(approval.category).font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(tint.opacity(0.18), in: Capsule())
                        .foregroundStyle(tint)
                }
                Spacer()
            }

            if let summary = inputSummary {
                Text(summary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }

            HStack(spacing: 12) {
                Button(role: .destructive, action: onDeny) {
                    Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button(action: onAllow) {
                    Label("Allow", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private var icon: String {
        switch approval.category {
        case "bash", "execute": return "terminal"
        case "edit", "write": return "pencil"
        case "read": return "doc.text"
        default: return "shield.lefthalf.filled"
        }
    }

    private var tint: Color {
        switch approval.category {
        case "bash", "execute": return .orange
        case "edit", "write": return .blue
        default: return .secondary
        }
    }

    private var inputSummary: String? {
        guard case .object(let object) = approval.input else {
            return approval.input.string
        }
        for key in ["command", "file_path", "path", "pattern", "url", "content"] {
            if let value = object[key]?.string { return value }
        }
        return object.keys.sorted().first.flatMap { key in object[key]?.string.map { "\(key): \($0)" } }
    }
}
