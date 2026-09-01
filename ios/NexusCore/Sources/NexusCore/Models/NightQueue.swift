import Foundation

/// Night-queue board (`GET /api/night-queue`, proxied from the assistant
/// adapter's `/v1/night-queue` — baker-internal#111). Mirror of
/// `NightQueueResponse` in `src/frontend/src/api.ts`. Wire keys are
/// snake_case, so the shared `.nexusREST` decoder applies.
///
/// Read-only surface: the queue is filled by minting a `night-queue` label in
/// daytime discussion, never from a dashboard.
public struct NightQueueResponse: Decodable, Sendable {
    /// False when the backend has no assistant URL/key configured.
    public let configured: Bool?
    /// False until the overnight runner has written its first night. Distinct
    /// from `error`: "nothing has happened yet" is not "I cannot tell".
    public let available: Bool?
    public let nights: [Night]
    /// What the scheduled launchd job last did. Absent on older adapters.
    public let lastAttempt: NightAttempt?
    public let queue: [QueuedIssue]
    public let openPrs: [NightQueuePR]
    /// Per-section reasons. `*Stale` means the list below is the last good
    /// answer, not a current one.
    public let queueError: String?
    public let queueStale: Bool?
    public let openPrsError: String?
    public let openPrsStale: Bool?
    public let generatedAt: Int?
    /// Set when the backend could not reach the adapter at all.
    public let error: String?
}

/// What the scheduled launchd job last did, from the wrapper's status file.
///
/// The ledger cannot answer "did the job even run?": a night that dies before
/// the runner opens it writes no row, so between 2026-08-29 and 09-01 the
/// runner crashed on an import four nights running and the board showed a
/// four-day-old night as if all were well. This is the only evidence such an
/// attempt happened.
public struct NightAttempt: Decodable, Sendable {
    public let started: Int?
    public let ended: Int?
    public let rc: Int?
    public let timedOut: Bool?
    /// "status" (the wrapper's JSON) or "stamp" (a legacy `.last` file).
    public let source: String?
    /// `rc == 0`. A legacy stamp carries no exit code and reports false —
    /// unknown is not success.
    public let ok: Bool
    /// Whether a ledger night covers this attempt. Independent of `ok`: a run
    /// that exited 0 and wrote no night is still unaccounted for. `nil` when
    /// there is no ledger to check, which is not the same as "went missing".
    public let recorded: Bool?

    /// The one state worth interrupting the reader for.
    public var isUnaccountedFor: Bool { recorded == false }
}

/// `quiet` — nothing was labelled. The normal night, and not a failure.
public enum NightOutcome: String, Decodable, Sendable {
    case worked, quiet, running, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NightOutcome(rawValue: raw) ?? .unknown
    }
}

/// What the RUNNER observed, never the coder model's claim about its own
/// homework. Decoded as an optional on `NightRun`, where a JSON `null` means
/// the ledger row predates the column — unknown, which is not `notRun`.
public enum NightTests: String, Decodable, Sendable {
    case passed
    case failed
    case notRun = "not_run"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NightTests(rawValue: raw) ?? .unknown
    }
}

public struct Night: Decodable, Sendable, Identifiable {
    public let id: String
    public let startedAt: String?
    public let startedTs: Int?
    public let endedAt: String?
    public let endedTs: Int?
    /// drained | window_closed | token_budget | max_issues | fatal
    public let stopReason: String?
    public let issuesPlanned: Int
    public let issuesAttempted: Int
    public let tokensUsed: Int
    public let outcome: NightOutcome
    /// Rollups the adapter computes so web and iOS cannot disagree.
    public let prsOpened: Int
    /// PRs opened without a green test run from the runner itself.
    public let unvalidated: Int
    public let failures: Int
    public let runs: [NightRun]
    /// Only present on the night-detail endpoint.
    public let plan: NightPlan?
}

public struct NightRun: Decodable, Sendable, Identifiable {
    public let id: String
    public let repo: String
    public let issueNumber: Int
    public let branch: String?
    public let startedAt: String?
    public let startedTs: Int?
    public let endedAt: String?
    public let endedTs: Int?
    /// pr_opened | parked | no_changes | timeout | failed
    public let status: String?
    public let rounds: Int
    /// approve | arbitrated_ship | arbitrated_park | unreviewed
    public let verdict: String?
    public let prUrl: String?
    public let tokensUsed: Int
    public let error: String?
    public let summary: String
    /// `nil` = the ledger row predates the column (unknown), NOT `notRun`.
    public let tests: NightTests?
    public let issueUrl: String?

    /// A PR the runner could not prove. The board must never let the PR link
    /// be the loudest thing on such a row.
    public var isUnvalidatedPR: Bool { status == "pr_opened" && tests != .passed }
}

/// What the planner decided. Deliberately carries no issue body or comments —
/// the adapter strips them, since untrusted GitHub prose has no business being
/// re-served to a dashboard.
public struct NightPlan: Decodable, Sendable {
    public let selected: [Selected]
    public let parked: [Parked]
    public let excluded: [Excluded]

    public struct Selected: Decodable, Sendable, Identifiable {
        public var id: String { "\(repo ?? "?")#\(number ?? 0)" }
        public let repo: String?
        public let number: Int?
        public let title: String?
        public let model: String?
        public let budgetTokens: Int?
        public let rationale: String?
    }

    public struct Parked: Decodable, Sendable, Identifiable {
        public var id: String { "\(repo ?? "?")#\(number ?? 0)" }
        public let repo: String?
        public let number: Int?
        public let reason: String?
    }

    public struct Excluded: Decodable, Sendable, Identifiable {
        public var id: String { "\(repo ?? "?")#\(number ?? 0)" }
        public let repo: String?
        public let number: Int?
        public let title: String?
    }
}

/// An open `night-queue`-labelled issue: what tonight's 01:00 run will consider.
public struct QueuedIssue: Decodable, Sendable, Identifiable {
    public var id: String { "\(repo)#\(number)" }
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let updatedAt: String?
    public let updatedTs: Int?
    /// baker-internal and nexus: labelled, but standing policy means the
    /// unattended agent never touches its own runtime or this surface.
    public let excluded: Bool
    /// The spec the planner will judge — the newest human comment, or the
    /// issue body. Never the runner's own bookkeeping chatter.
    public let readiness: String?
    /// "comment" or "body".
    public let readinessSource: String?
}

/// An open `night-queue-output` PR: work waiting on Keith.
public struct NightQueuePR: Decodable, Sendable, Identifiable {
    public var id: String { "\(repo)#\(number)" }
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let createdAt: String?
    public let createdTs: Int?
    public let isDraft: Bool
}
