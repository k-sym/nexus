import SwiftUI
import NexusCore

/// Drives connection onboarding and holds the app's auth state. Mirrors the
/// desktop shell's resolve-then-probe flow: normalize the base URL, hit the
/// unauthenticated `/api/health`, then validate the bearer with an authed
/// `/api/projects`. The base URL persists in UserDefaults; the token lives in
/// the Keychain (via `TokenStore`).
@MainActor
@Observable
final class ConnectionStore {
    enum Phase: Equatable {
        case unconfigured
        case connecting
        case connected
        case unreachable(String)
        case tokenRejected
    }

    // Bound to the onboarding form.
    var baseURLText: String = ""
    var tokenText: String = ""

    private(set) var phase: Phase = .unconfigured
    private(set) var projectCount: Int?
    private(set) var host: String?

    /// Shared client, handed to feature view models.
    let api: APIClient
    private let tokenStore: TokenStore

    private static let baseURLKey = "nexus.baseURL"

    init(api: APIClient, tokenStore: TokenStore = .standard) {
        self.api = api
        self.tokenStore = tokenStore
    }

    var hasStoredToken: Bool { tokenStore.token() != nil }

    /// Restore a saved connection on launch; if a base URL + token are already
    /// stored, reconnect automatically. Otherwise prefill the dev URL in DEBUG.
    func loadPersisted() async {
        if let saved = UserDefaults.standard.string(forKey: Self.baseURLKey), !saved.isEmpty {
            baseURLText = saved
            if hasStoredToken {
                await connect()
                return
            }
        }
        #if DEBUG
        // Dev/verification hook: `NEXUS_DEV_URL` in the launch environment
        // auto-connects (no token) against a local stub. Never present in
        // release builds.
        if let devURL = ProcessInfo.processInfo.environment["NEXUS_DEV_URL"], !devURL.isEmpty {
            baseURLText = devURL
            await connect()
            return
        }
        if baseURLText.isEmpty, let dev = BuildConfig.devBaseURL {
            baseURLText = dev
        }
        #endif
    }

    /// Normalize the entered URL, persist the token, then probe reachability and
    /// auth. Sets `phase` to the outcome.
    func connect() async {
        let normalized = Self.normalize(baseURLText)
        guard let url = URL(string: normalized), url.scheme != nil, url.host != nil else {
            phase = .unreachable("Enter a full URL like https://host.ts.net:8444")
            return
        }

        phase = .connecting
        host = url.host

        let trimmedToken = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty {
            tokenStore.setToken(trimmedToken)
            tokenText = ""
        }

        await api.configure(baseURL: url)

        // 1) Reachability (unauthenticated).
        do {
            guard try await api.health() else {
                phase = .unreachable("Backend reachable but health check failed.")
                return
            }
        } catch {
            phase = .unreachable(Self.message(for: error))
            return
        }

        // 2) Token validation via an authed call.
        do {
            let projects = try await api.projects()
            projectCount = projects.count
            UserDefaults.standard.set(normalized, forKey: Self.baseURLKey)
            phase = .connected
        } catch APIError.unauthorized {
            phase = .tokenRejected
        } catch {
            phase = .unreachable(Self.message(for: error))
        }
    }

    /// Forget the current connection (keeps the entered base URL for convenience).
    func disconnect() async {
        tokenStore.deleteToken()
        UserDefaults.standard.removeObject(forKey: Self.baseURLKey)
        await api.configure(baseURL: nil)
        projectCount = nil
        phase = .unconfigured
    }

    // MARK: Helpers

    static func normalize(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return value }
        if !value.contains("://") { value = "https://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    private static func message(for error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
