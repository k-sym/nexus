import SwiftUI
import NexusCore

/// Generic async-load state used by every feature view model.
enum LoadState<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }

    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
}

extension LoadState {
    /// Map an error to a user-facing message using APIError's descriptions.
    static func message(for error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

/// Standard cadences mirrored from the desktop's polling loops. Live-streamed
/// surfaces (chat, approvals) use push instead and are not represented here.
enum PollingCadence {
    static let missionControl: Duration = .seconds(15)
    static let activity: Duration = .seconds(15)
    static let tasks: Duration = .seconds(5)
    static let sessions: Duration = .seconds(5)
    static let projects: Duration = .seconds(30)
}

/// Runs `action` immediately, then repeats every `interval` while the view is
/// on screen AND the scene is active. Re-keys on `scenePhase` so backgrounding
/// tears the loop down and foregrounding restarts it — nothing polls in the
/// background.
private struct PollingModifier: ViewModifier {
    let interval: Duration
    let action: () async -> Void
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await action()
                do { try await Task.sleep(for: interval) } catch { return }
            }
        }
    }
}

extension View {
    /// Poll `action` on `cadence` while visible and foregrounded.
    func polling(_ cadence: Duration, _ action: @escaping () async -> Void) -> some View {
        modifier(PollingModifier(interval: cadence, action: action))
    }
}

/// Inline error state with an optional retry.
struct ErrorStateView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("Something went wrong", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retry {
                Button("Try again", action: retry)
            }
        }
    }
}
