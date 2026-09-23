import SwiftUI
import NexusCore

/// The last project list the app fetched, kept in memory so a picker opens
/// with rows in hand instead of waiting on the network. Anything that fetches
/// `/api/projects` stores into it; a picker shows what is here at once and
/// refreshes behind it. Cleared on disconnect so a new backend never shows
/// the old one's projects.
@MainActor
@Observable
final class ProjectsCache {
    static let shared = ProjectsCache()

    private(set) var projects: [Project] = []
    private(set) var fetchedAt: Date?
    private var inFlight: Task<Error?, Never>?
    /// Bumped by `clear()`: a fetch started before a disconnect belongs to the
    /// old backend and must not land in the cache afterwards.
    private var generation = 0

    /// Record a list fetched elsewhere (onboarding, the Projects tab).
    func store(_ projects: [Project]) {
        self.projects = projects
        fetchedAt = Date()
    }

    /// Fetch again unless a fetch is already running or the list is younger than
    /// `maxAge`. Throws only when there is nothing cached to fall back on.
    func refresh(api: APIClient, maxAge: TimeInterval = 30) async throws {
        if let fetchedAt, Date().timeIntervalSince(fetchedAt) < maxAge, !projects.isEmpty { return }
        let task: Task<Error?, Never>
        if let inFlight {
            task = inFlight
        } else {
            let started = generation
            task = Task { @MainActor in
                do {
                    let fetched = try await api.projects()
                    if started == self.generation { self.store(fetched) }
                    return nil
                } catch { return error }
            }
            inFlight = task
        }
        let failure = await task.value
        if inFlight == task { inFlight = nil }
        if let failure, projects.isEmpty { throw failure }
    }

    func clear() {
        generation += 1
        inFlight?.cancel()
        inFlight = nil
        projects = []
        fetchedAt = nil
    }
}
