import SwiftUI
import NexusCore

/// Hosts the two system-wide read-only surfaces behind a segmented control:
/// the Mission Control dashboard and the Activity console.
struct PulseView: View {
    let api: APIClient

    enum Tab: String, CaseIterable, Identifiable {
        case dashboard = "Dashboard"
        case activity = "Activity"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .dashboard

    var body: some View {
        VStack(spacing: 0) {
            Picker("Pulse", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding([.horizontal, .top])
            .padding(.bottom, 8)

            Divider()

            switch tab {
            case .dashboard: MissionControlView(api: api)
            case .activity: ActivityView(api: api)
            }
        }
        .navigationTitle("Pulse")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A titled rounded container used by the dashboard cards.
struct Card<Content: View>: View {
    let title: String
    var systemImage: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(title).font(.subheadline.weight(.semibold))
            } icon: {
                if let systemImage { Image(systemName: systemImage) }
            }
            .foregroundStyle(.secondary)

            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: Theme.cornerRadius))
    }
}
