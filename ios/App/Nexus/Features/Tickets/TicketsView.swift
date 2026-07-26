import SwiftUI
import NexusCore

@MainActor
@Observable
final class TicketsViewModel {
    private let api: APIClient
    var state: LoadState<[Ticket]> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.tickets())
        } catch {
            state = .failed(LoadState<[Ticket]>.message(for: error))
        }
    }
}

/// Read-only Jira mirror. Tapping a row opens the ticket in Jira (its `url`).
struct TicketsView: View {
    @State private var vm: TicketsViewModel

    init(api: APIClient) {
        _vm = State(initialValue: TicketsViewModel(api: api))
    }

    var body: some View {
        content
            .navigationTitle("Tickets")
            .refreshable { await vm.refresh() }
            .polling(PollingCadence.sessions) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let tickets):
            if tickets.isEmpty {
                ContentUnavailableView("No tickets", systemImage: "ticket", description: Text("Jira tickets synced to Nexus appear here."))
            } else {
                List(tickets) { ticket in
                    TicketRow(ticket: ticket)
                }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct TicketRow: View {
    let ticket: Ticket

    var body: some View {
        let row = VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(ticket.key).font(.caption.weight(.bold)).foregroundStyle(Theme.accent)
                Spacer()
                Text(ticket.status).font(.caption).foregroundStyle(.secondary)
            }
            Text(ticket.summary).font(.body).lineLimit(2)
            HStack(spacing: 8) {
                Label(ticket.priority, systemImage: "flag").labelStyle(.titleAndIcon)
                if let assignee = ticket.assignee {
                    Label(assignee, systemImage: "person").labelStyle(.titleAndIcon)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)

        if let urlString = ticket.url, let url = URL(string: urlString) {
            Link(destination: url) { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }
}
