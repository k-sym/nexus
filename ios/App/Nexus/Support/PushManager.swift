import SwiftUI
import UserNotifications
import NexusCore

/// Owns push registration: asks permission, registers with APNs, posts the
/// device token to the backend, and routes a notification tap to `AppRouter`.
/// The raw APNs callbacks arrive via `AppDelegate`, which forwards to here.
@MainActor
@Observable
final class PushManager: NSObject {
    private let api: APIClient
    let router: AppRouter
    private(set) var deviceToken: String?

    init(api: APIClient, router: AppRouter) {
        self.api = api
        self.router = router
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Called once connected: request authorization, then register with APNs.
    func enable() {
        Task {
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Deregister on sign-out so the backend stops pushing to this device.
    func disable() {
        guard let token = deviceToken else { return }
        deviceToken = nil
        Task { try? await api.deleteDevice(token: token) }
    }

    // MARK: AppDelegate forwards

    func didRegister(tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        Task { try? await api.registerDevice(token: token, env: Self.environment) }
    }

    /// A silent `content-available` push arrived. Foreground views already
    /// poll/rehydrate; this is the background hook (a real background fetch
    /// would refresh here).
    func didReceiveSilentPush() { /* reserved for background rehydrate */ }

    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    /// Show a banner even while the app is foregrounded.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// Tap → deep-link to the thread/approval.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        if let nexus = info["nexus"] as? [String: Any], let deepLink = nexus["deepLink"] as? String {
            router.handle(deepLink: deepLink)
        }
    }
}
