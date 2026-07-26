import UIKit

/// SwiftUI's App lifecycle has no APNs registration callbacks, so we bridge
/// through a `UIApplicationDelegate`. `NexusApp` wires `push` after launch.
final class AppDelegate: NSObject, UIApplicationDelegate {
    weak var push: PushManager?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in push?.didRegister(tokenData: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on a Simulator without a paired push service; ignore.
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await MainActor.run { push?.didReceiveSilentPush() }
        return .newData
    }
}
