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

/// Jira mirror. Tapping a row opens the ticket detail: read it, draft the
/// problem with Sonnet, pick a project and model, Go into a session (#432).
struct TicketsView: View {
    @State private var vm: TicketsViewModel
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
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
                    NavigationLink {
                        TicketDetailView(api: api, ticket: ticket)
                    } label: {
                        TicketRow(ticket: ticket)
                    }
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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(ticket.key).font(.caption.weight(.bold)).foregroundStyle(Theme.accent)
                if ticket.session != nil {
                    Text("SESSION")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.accent.opacity(0.5)))
                        .accessibilityLabel("Has a session")
                }
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
    }
}
