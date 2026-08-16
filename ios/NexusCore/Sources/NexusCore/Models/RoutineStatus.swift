import Foundation

/// Partner routine fleet (`GET /api/routines`, proxied from the assistant
/// adapter's `/v1/routines` — baker-internal#82). Mirror of `RoutinesResponse`
/// in `src/frontend/src/api.ts`. Wire keys are snake_case, so the shared
/// `.nexusREST` decoder applies. Read-only surface: no start/stop in v1.
public struct RoutinesResponse: Decodable, Sendable {
    /// False when the backend has no assistant URL/key configured.
    public let configured: Bool?
    public let routines: [Routine]
    public let generatedAt: Int?
    /// Set (with an empty `routines`) when the adapter was unreachable.
    public let error: String?
}

/// Health of one scheduled job, as the adapter computes it. `stale` — a slot
/// passed with no run — is the state the fleet card exists to surface.
public enum RoutineHealth: String, Decodable, Sendable {
    case ok
    case failed
    case stale
    case pending
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RoutineHealth(rawValue: raw) ?? .unknown
    }
}

public struct Routine: Decodable, Sendable, Identifiable {
    public var id: String { name }

    public let name: String
    /// Full launchd label (`com.k-sym.partner.<name>`).
    public let label: String
    /// Human schedule summary, e.g. "daily 07:05" or "Mon Tue Wed Thu Fri 08:05".
    public let scheduleDisplay: String
    public let lastRun: LastRun?
    public let health: RoutineHealth
    /// Epoch seconds of the most recent scheduled slot / the next one.
    public let lastExpected: Int?
    public let nextDue: Int?
    /// Last ~15 log lines. Only present on the detail endpoint.
    public let logTail: [String]?

    public struct LastRun: Decodable, Sendable {
        public let started: Int?
        public let ended: Int?
        public let rc: Int?
        public let timedOut: Bool?
        /// "status" (wrapper JSON) or "stamp" (legacy *.last fallback).
        public let source: String?
    }
}
