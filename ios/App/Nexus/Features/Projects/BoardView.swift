import SwiftUI
import NexusCore

/// Session-first board (#439). One `GET /board` call returns the project's
/// sessions with a derived lane each, plus the Inbox of open GitHub issues and
/// Monday items with no session yet. Nothing is stored per lane, so there is
/// nothing to move: the model only reads.
@MainActor
@Observable
final class BoardViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<BoardResponse> = .idle

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.board(projectId: projectId))
        } catch {
            // A 5 s poll must not blank a board it already showed for one
            // transient failure; only a cold load surfaces the error state.
            if state.value == nil { state = .failed(LoadState<BoardResponse>.message(for: error)) }
        }
    }
}

/// A `List` with one section per lane in order: Inbox, Running, Needs you,
/// Idle, Done. Inbox rows push `OriginDetailView`; cards open their thread as a
/// cover through the router (the same path the Tickets detail uses). The `+`
/// files an idea (D14) — the board is not a place to park work.
struct BoardView: View {
    private let api: APIClient
    @State private var vm: BoardViewModel
    @Environment(AppRouter.self) private var router

    init(api: APIClient, projectId: String) {
        self.api = api
        _vm = State(initialValue: BoardViewModel(api: api, projectId: projectId))
    }

    var body: some View {
        content
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink {
                        IdeasView(api: api)
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New idea")
                }
            }
            // Runs now, then every 5 s while the view is on screen and the scene
            // is active; the loop exits as soon as its task is cancelled.
            .polling(PollingCadence.board) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        case .loaded(let board):
            List {
                ForEach(BoardLane.allCases, id: \.rawValue) { lane in
                    if lane == .inbox {
                        inboxSection(board)
                    } else {
                        laneSection(lane, cards: board.cards(in: lane))
                    }
                }
                // Cards the server filed under a lane this build does not know
                // still show, in their own section, rather than vanishing.
                ForEach(unknownLanes(in: board), id: \.rawValue) { lane in
                    laneSection(lane, cards: board.cards(in: lane))
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await vm.refresh() }
        }
    }

    private func unknownLanes(in board: BoardResponse) -> [BoardLane] {
        var seen: [BoardLane] = []
        for card in board.cards {
            if case .unknown = card.lane, !seen.contains(card.lane) { seen.append(card.lane) }
        }
        return seen
    }

    // MARK: Inbox

    private func inboxSection(_ board: BoardResponse) -> some View {
        Section {
            ForEach(board.inbox) { item in
                NavigationLink {
                    OriginDetailView(api: api, projectId: vm.projectId, item: item)
                } label: {
                    InboxRow(item: item)
                }
            }
        } header: {
            laneHeader(.inbox, count: board.inbox.count)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if board.inbox.isEmpty {
                    Text("Nothing waiting. Park thoughts in Ideas.")
                }
                if let error = board.inboxErrors.github {
                    Label("GitHub: \(error)", systemImage: "exclamationmark.triangle")
                }
                if let error = board.inboxErrors.monday {
                    Label("Monday: \(error)", systemImage: "exclamationmark.triangle")
                }
            }
        }
    }

    // MARK: Card lanes

    private func laneSection(_ lane: BoardLane, cards: [BoardCard]) -> some View {
        Section {
            ForEach(cards) { card in
                Button {
                    router.openThread = OpenThread(id: card.thread.id, title: card.thread.title)
                } label: {
                    CardRow(card: card)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the session")
            }
        } header: {
            laneHeader(lane, count: cards.count)
        }
    }

    private func laneHeader(_ lane: BoardLane, count: Int) -> some View {
        HStack {
            Text(lane.label)
            Spacer()
            Text("\(count)").monospacedDigit()
        }
    }
}

// MARK: - Rows

/// An Inbox row: kind badge (`#439` for GitHub, `Monday` for Monday), title,
/// then labels or the Monday status.
private struct InboxRow: View {
    let item: BoardInboxItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OriginBadge(text: badgeText, tint: badgeTint)
                Text(item.title).font(.body).lineLimit(2)
            }
            if let detail {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var badgeText: String {
        switch item.kind {
        case .github: return "#\(item.id)"
        case .monday: return "Monday"
        case .unknown(let raw): return raw.capitalized
        }
    }

    private var badgeTint: Color {
        switch item.kind {
        case .github: return .purple
        case .monday: return .pink
        case .unknown: return .secondary
        }
    }

    private var detail: String? {
        var parts: [String] = []
        if let status = item.statusLabel, !status.isEmpty { parts.append(status) }
        if !item.labels.isEmpty { parts.append(item.labels.joined(separator: " · ")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// A card row: title, origin badge, running indicator, the "Needs you" counts
/// when a gate is pending, and the relative last-activity time.
private struct CardRow: View {
    let card: BoardCard

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let badge = originBadge {
                    OriginBadge(text: badge.text, tint: badge.tint)
                }
                Text(card.thread.title).font(.body).lineLimit(2)
                Spacer(minLength: 0)
                if card.running {
                    ProgressView().controlSize(.mini)
                        .accessibilityLabel("Running")
                }
            }
            HStack(spacing: 6) {
                if let needsYou {
                    Label(needsYou, systemImage: "hand.raised.fill")
                        .foregroundStyle(.orange)
                }
                if let when = updated {
                    if needsYou != nil { Text("·") }
                    Text(when)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var originBadge: (text: String, tint: Color)? {
        switch card.origin {
        case .ticket(let key, _): return (key, .blue)
        case .github(let number, _): return ("#\(number)", .purple)
        case .monday(_, let name, _): return (name, .pink)
        case .chat: return nil
        case .unknown(let kind): return (kind.capitalized, .secondary)
        }
    }

    private var needsYou: String? {
        guard card.lane == .needsYou || card.pendingQuestions > 0 || card.pendingApprovals > 0 else { return nil }
        var parts: [String] = []
        if card.pendingQuestions > 0 {
            parts.append("\(card.pendingQuestions) question\(card.pendingQuestions == 1 ? "" : "s")")
        }
        if card.pendingApprovals > 0 {
            parts.append("\(card.pendingApprovals) approval\(card.pendingApprovals == 1 ? "" : "s")")
        }
        return parts.isEmpty ? "Needs you" : "Needs you · " + parts.joined(separator: ", ")
    }

    private var updated: String? {
        RelativeTime.parse(card.thread.updatedAt).map { RelativeTime.string(from: $0) }
    }
}

/// Small tinted capsule naming a card's or Inbox item's origin.
private struct OriginBadge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold).monospacedDigit())
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
            .layoutPriority(1)
    }
}
