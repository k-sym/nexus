import SwiftUI

/// Top-level destinations. On iPhone these map onto a 5-tab bar (Assistant,
/// Projects, Approvals, Pulse, More→{Tickets, Braindump, Settings}); on iPad
/// they all sit in the split-view sidebar.
enum AppSection: String, CaseIterable, Identifiable, Hashable {
    case assistant
    case projects
    case approvals
    case pulse
    case tickets
    case braindump
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .assistant: return "Assistant"
        case .projects: return "Projects"
        case .approvals: return "Approvals"
        case .pulse: return "Pulse"
        case .tickets: return "Tickets"
        case .braindump: return "Braindump"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .assistant: return "bubble.left.and.text.bubble.right.fill"
        case .projects: return "folder.fill"
        case .approvals: return "checkmark.shield.fill"
        case .pulse: return "waveform.path.ecg"
        case .tickets: return "ticket.fill"
        case .braindump: return "lightbulb.fill"
        case .settings: return "gearshape.fill"
        }
    }
}
