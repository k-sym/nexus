import Foundation

/// Which resource a 409 turn-conflict refers to. Forward-compatible.
public enum BusyKind: String, Decodable, Sendable {
    case threadBusy = "thread_busy"
    case modelBusy = "model_busy"
    case projectBusy = "project_busy"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BusyKind(rawValue: raw) ?? .unknown
    }
}

/// Body of a 409 from the chat/assistant stream endpoints. Fields are
/// camelCase on the wire, so decode with `JSONDecoder.nexusCamel`.
public struct BusyInfo: Decodable, Sendable {
    public let kind: BusyKind
    public let activeThreadId: String?
    public let activeTitle: String?
    public let modelKey: String?

    static func decode(from data: Data) -> BusyInfo {
        (try? JSONDecoder.nexusCamel.decode(BusyInfo.self, from: data))
            ?? BusyInfo(kind: .unknown, activeThreadId: nil, activeTitle: nil, modelKey: nil)
    }
}

/// The single error boundary for all backend calls. `APIClient` maps every
/// failure into one of these so callers never see raw HTTP or URLSession types.
public enum APIError: Error, Sendable {
    /// No base URL configured yet (pre-onboarding).
    case notConfigured
    /// 401 — bad/missing bearer token. Callers should route back to onboarding.
    case unauthorized
    /// 409 — a turn is already running; retry with `X-Confirm-Cancel: true`.
    case busy(BusyInfo)
    /// Any other non-2xx response.
    case server(status: Int, message: String?)
    /// The body couldn't be decoded into the expected type.
    case decoding(Error)
    /// TLS/offline/timeout — the request never got a valid HTTP response.
    case transport(URLError)
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notConfigured: return "Not connected to a Nexus backend yet."
        case .unauthorized: return "The access token was rejected."
        case .busy(let info):
            let title = info.activeTitle ?? "another turn"
            return "Busy — \(title) is already running."
        case .server(let status, let message):
            return message ?? "Server error (HTTP \(status))."
        case .decoding: return "The server sent an unexpected response."
        case .transport(let err): return err.localizedDescription
        }
    }
}
