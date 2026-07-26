import SwiftUI
import NexusCore

/// The connected app shell. Adaptive: a tab bar on iPhone (compact width) and a
/// three-pane split view on iPad (regular width). Both drive the same section
/// destinations, so feature views provide content + a title and let the shell
/// own the NavigationStack.
struct RootShellView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(LiveHub.self) private var liveHub
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: AppSection? = .projects
    @State private var tabSelection: String = Self.initialTab

    private var api: APIClient { connection.api }

    /// Default compact tab. A DEBUG-only `NEXUS_DEV_TAB` env override lets
    /// verification launch straight into a given surface.
    private static var initialTab: String {
        #if DEBUG
        if let tab = ProcessInfo.processInfo.environment["NEXUS_DEV_TAB"], !tab.isEmpty {
            return tab
        }
        #endif
        return "assistant"
    }

    var body: some View {
        shell
            .task { liveHub.start() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { liveHub.start() } else if phase == .background { liveHub.stop() }
            }
    }

    @ViewBuilder
    private var shell: some View {
        #if DEBUG
        // Verification hook: launch straight into a specific view.
        if let spec = ProcessInfo.processInfo.environment["NEXUS_DEV_VIEW"], !spec.isEmpty {
            NavigationStack { debugDestination(spec) }
        } else {
            adaptiveBody
        }
        #else
        adaptiveBody
        #endif
    }

    #if DEBUG
    @ViewBuilder
    private func debugDestination(_ spec: String) -> some View {
        let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
        let arg = parts.count > 1 ? parts[1] : ""
        switch parts.first {
        case "chat": StreamingChatView(api: api, threadId: arg, title: "Chat")
        case "board": KanbanBoardView(api: api, projectId: arg).navigationTitle("Board").navigationBarTitleDisplayMode(.inline)
        case "memory": MemoryView(api: api, projectId: arg).navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
        case "missions": MissionsView(api: api, projectId: arg).navigationTitle("Missions").navigationBarTitleDisplayMode(.inline)
        case "braindump": BraindumpView(api: api)
        case "approvals": ApprovalsView()
        case "monday": MondayView(api: api, projectId: arg).navigationTitle("Monday").navigationBarTitleDisplayMode(.inline)
        case "diff": DiffView(api: api, projectId: arg).navigationTitle("Diff").navigationBarTitleDisplayMode(.inline)
        case "settings": SettingsView()
        default: adaptiveBody
        }
    }
    #endif

    @ViewBuilder
    private var adaptiveBody: some View {
        if sizeClass == .regular {
            splitView
        } else {
            tabView
        }
    }

    // MARK: iPhone

    private var tabView: some View {
        TabView(selection: $tabSelection) {
            NavigationStack { destination(for: .assistant) }
                .tabItem { Label(AppSection.assistant.title, systemImage: AppSection.assistant.systemImage) }
                .tag("assistant")

            NavigationStack { destination(for: .projects) }
                .tabItem { Label(AppSection.projects.title, systemImage: AppSection.projects.systemImage) }
                .tag("projects")

            NavigationStack { destination(for: .approvals) }
                .tabItem { Label(AppSection.approvals.title, systemImage: AppSection.approvals.systemImage) }
                .badge(liveHub.pendingCount)
                .tag("approvals")

            NavigationStack { destination(for: .pulse) }
                .tabItem { Label(AppSection.pulse.title, systemImage: AppSection.pulse.systemImage) }
                .tag("pulse")

            moreTab
                .tabItem { Label("More", systemImage: "ellipsis") }
                .tag("more")
        }
    }

    private var moreTab: some View {
        NavigationStack {
            List {
                ForEach([AppSection.tickets, .braindump, .settings]) { section in
                    NavigationLink {
                        destination(for: section)
                    } label: {
                        Label(section.title, systemImage: section.systemImage)
                    }
                }
            }
            .navigationTitle("More")
        }
    }

    // MARK: iPad

    private var splitView: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.systemImage).tag(section)
                }
            }
            .navigationTitle("Nexus")
        } detail: {
            NavigationStack {
                destination(for: selection ?? .projects)
            }
        }
    }

    // MARK: Destinations

    @ViewBuilder
    private func destination(for section: AppSection) -> some View {
        switch section {
        case .assistant:
            PlaceholderView(title: "Assistant", systemImage: section.systemImage, note: "Streaming chat lands in M2.")
        case .projects:
            ProjectsListView(api: api)
        case .approvals:
            ApprovalsView()
        case .pulse:
            PulseView(api: api)
        case .tickets:
            TicketsView(api: api)
        case .braindump:
            BraindumpView(api: api)
        case .settings:
            SettingsView()
        }
    }
}
