import Foundation

/// Mission Control dashboard payload (`GET /api/mission-control`). Mirror of
/// `MissionStatus` in `src/frontend/src/api.ts`. Its keys are camelCase
/// (`modelCounts`, `usedPercent`…); `.convertFromSnakeCase` is a no-op on them,
/// so the shared `nexusREST` decoder still applies.
public struct MissionStatus: Decodable, Sendable {
    public let memory: Memory
    public let models: [ModelInfo]
    public let modelCounts: ModelCounts?
    public let stats: [String: ProviderStat]?

    public struct Memory: Decodable, Sendable {
        public let ok: Bool
        public let status: String?
        public let memories: Int?
        public let jobs: Jobs?
        public let models: Models?
        public let error: String?

        public struct Jobs: Decodable, Sendable {
            public let pending: Int
            public let dead: Int
        }
        public struct Models: Decodable, Sendable {
            public let gen: Bool
            public let embed: Bool
            public let rerank: Bool
        }
    }

    public struct ModelInfo: Decodable, Hashable, Sendable {
        public let provider: String
        public let id: String
        public let name: String
        public let reasoning: Bool?
        public let contextWindow: Int?
        public let maxTokens: Int?
        public let configured: Bool

        /// Stable composite identity for lists (`provider/id`).
        public var key: String { "\(provider)/\(id)" }
    }

    public struct ModelCounts: Decodable, Sendable {
        public let active: Int
        public let available: Int
    }

    /// Per-provider usage tile (claude / codex / openrouter).
    public struct ProviderStat: Decodable, Sendable {
        public let ok: Bool
        public let value: String
        public let caption: String
        public let source: String?
        public let sampledAt: String?
        public let error: String?
        public let windows: [String: Window]?

        public struct Window: Decodable, Sendable {
            public let usedPercent: Double?
            public let remainingPercent: Double?
            public let resetLabel: String?
            public let resetsAt: String?
            public let windowMinutes: Int?
        }
    }
}
