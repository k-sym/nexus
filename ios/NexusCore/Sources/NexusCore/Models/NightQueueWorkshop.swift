import Foundation

/// Readiness workshop (baker-internal#111) — the daylight half of the night
/// queue, as the backend proxies it from the partner adapter. Mirror of the
/// workshop types in `src/frontend/src/api.ts`; wire keys are snake_case, so
/// the shared `.nexusREST` decoder applies.
///
/// Three reads, one conversation, and one write. The write — arming — posts a
/// readiness comment and mints the `night-queue` label, which is the moment an
/// issue is handed to an unattended agent for a whole night. Every guard on it
/// lives in the adapter; the types here exist so the phone can MIRROR those
/// refusals rather than discover them after a round trip.
///
/// Nothing in this file re-states the readiness bar. The criteria are served
/// by `/api/night-queue/readiness` precisely so a Swift copy cannot drift from
/// what the 01:00 planner actually enforces.

// MARK: - Candidates

/// Why an open PR blocks an issue: an explicit "Fixes #N", one of our own
/// `nq/` branches, or a branch named after the issue.
public enum BlockerReason: String, Decodable, Sendable {
    case linked
    case nqBranch = "nq_branch"
    case branchName = "branch_name"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BlockerReason(rawValue: raw) ?? .unknown
    }
}

/// An open PR that already implements the issue.
public struct NightQueueBlocker: Decodable, Sendable, Equatable {
    public let number: Int
    public let url: String
    public let branch: String
    public let reason: BlockerReason

    public init(number: Int, url: String, branch: String, reason: BlockerReason) {
        self.number = number
        self.url = url
        self.branch = branch
        self.reason = reason
    }
}

/// What structurally stops an issue being armed. `nil` on the wire means
/// nothing does — which is NOT the same as "ready": nothing in the candidate
/// list has been judged against the bar until it is assessed.
public enum BlockedReason: String, Decodable, Sendable, Equatable {
    /// Standing policy: the unattended agent never touches its own runtime or
    /// the surface it reports through.
    case excluded
    /// Already labelled — it is in tonight's queue.
    case queued
    case openPr = "open_pr"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BlockedReason(rawValue: raw) ?? .unknown
    }
}

/// An open issue that COULD be armed, carrying the reason it could not.
///
/// Blocked candidates are returned rather than filtered out, and the UI shows
/// them greyed with their reason: a list that silently omits an issue teaches
/// you it does not exist, while "PR #212 already implements this" teaches you
/// where the work went.
public struct NightQueueCandidate: Decodable, Sendable, Identifiable, Hashable {
    public var id: String { "\(repo)#\(number)" }
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let updatedAt: String?
    public let updatedTs: Int?
    public let labels: [String]
    public let queued: Bool
    public let excluded: Bool
    public let openPr: NightQueueBlocker?
    /// `nil` = nothing structurally blocks arming. Covers excluded / queued /
    /// open_pr in one field, so a gate written against it cannot miss a case
    /// the way a hand-rolled disjunction did on desktop.
    public let blocked: BlockedReason?

    public static func == (lhs: NightQueueCandidate, rhs: NightQueueCandidate) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

public struct NightQueueCandidatesResponse: Decodable, Sendable {
    /// False when the backend has no assistant URL/key configured.
    public let configured: Bool?
    public let candidates: [NightQueueCandidate]
    /// Count with no structural blocker. Deliberately NOT called "armable" —
    /// nothing here has been judged against the bar yet.
    public let unblocked: Int?
    public let generatedAt: Int?
    public let cached: Bool?
    /// True when the list below is the last good answer, not a current one.
    public let stale: Bool?
    public let error: String?
}

// MARK: - The bar

public struct ReadinessCriterion: Decodable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let requirement: String
    /// Set when the criterion only applies to some issues (reachability).
    public let conditional: String?
}

/// The readiness bar, served rather than duplicated. `night-queue/readiness.py`
/// is the single definition the 01:00 planner composes its prompt from, so a
/// workshop that blessed issues against a second copy would teach Keith to
/// trust a green light that does not bind.
public struct ReadinessResponse: Decodable, Sendable {
    public let configured: Bool?
    public let criteria: [ReadinessCriterion]
    /// The verbatim bar the planner enforces.
    public let barText: String?
    public let commentTemplate: String?
    public let excludedRepos: [String]?
    public let error: String?
}

// MARK: - Assessment

public enum CriterionStatus: String, Decodable, Sendable {
    case met, missing, na, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CriterionStatus(rawValue: raw) ?? .unknown
    }
}

public struct AssessedCriterion: Decodable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let status: CriterionStatus
    public let note: String
}

/// One issue judged against the bar. Costs a model call, so it is requested
/// per-issue and on demand — and a failure is an error rather than an empty
/// verdict: "I could not judge this" must never render as "nothing is wrong".
public struct AssessmentResponse: Decodable, Sendable {
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let state: String
    public let labels: [String]
    public let queued: Bool
    public let excluded: Bool
    public let openPr: NightQueueBlocker?
    /// Recomputed from the criteria, never taken from the model.
    public let ready: Bool
    /// False when the verdict was decided without a model call (excluded repo).
    public let assessed: Bool
    public let summary: String
    public let criteria: [AssessedCriterion]
    /// Gaps arrive as `<TODO: …>` and must be resolved before arming.
    public let draftComment: String

    /// Whether this verdict is about `candidate`. The stale-assessment guard:
    /// an assessment takes tens of seconds, so a verdict can land after the
    /// reader has moved on, and arming on a mismatched pair would post one
    /// issue's spec onto another and label it.
    public func describes(_ candidate: NightQueueCandidate) -> Bool {
        repo == candidate.repo && number == candidate.number
    }
}

// MARK: - The conversation before arming

/// A Partner conversation opened about one issue (baker-internal#131).
///
/// The adapter composes the seed — the readiness bar plus the issue text inside
/// its fence — and holds it against the session, so it rides on every turn
/// rather than only the first. Nothing here builds that fence: a second
/// spelling in Swift would be an injection path into the arming decision the
/// conversation exists to inform.
///
/// The session is the adapter's, so the app adopts it before chatting. The
/// Partner drafts and argues; it cannot arm, and its seed says so.
public struct DiscussResponse: Decodable, Sendable {
    /// The adapter-side session to adopt.
    public let sessionId: String
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let sessionTitle: String
}

// MARK: - Arming (the one write)

public struct ArmDecision: Decodable, Sendable {
    /// Autonomy-ledger class, e.g. `night-queue-arm:selfie-wall`. The
    /// `night-queue` prefix is permanently denylisted from ever going auto.
    public let armClass: String?
    public let recorded: Bool?
    public let promotable: Bool?
    public let streak: Int?
    /// Audit-only failure: reported ALONGSIDE the success, never over it, so a
    /// ledger hiccup cannot un-arm a correctly armed issue.
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        // `class` is a Swift keyword. `.convertFromSnakeCase` leaves a key
        // with no underscores alone, so this matches the wire key verbatim.
        case armClass = "class"
        case recorded, promotable, streak, error
    }
}

public struct ArmResponse: Decodable, Sendable {
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    public let queued: Bool
    public let label: String
    public let commentPosted: Bool
    public let decision: ArmDecision?
}

// MARK: - The arm gate

/// Whether Arm may be offered at all, and if not, why.
///
/// This mirrors refusals the adapter enforces anyway. It lives here, in
/// NexusCore, rather than inside a SwiftUI view for two reasons: it is the
/// safety-critical half of the workshop and deserves tests, and the view
/// should never be the only place a refusal is written down.
///
/// It deliberately does NOT re-implement every adapter rule — the bookkeeping
/// -prefix check stays server-side, where the planner's own filter is defined.
/// Two answers to one question would leave this side untested against a real
/// night.
public enum ArmGate {
    /// The adapter's own floor for "long enough to be a spec".
    public static let minimumCommentCharacters = 40
    /// The marker the assessor uses for a gap it will not decide for you.
    public static let unresolvedMarker = "<TODO"

    public enum Refusal: Equatable, Sendable {
        /// Nothing has been judged yet — the bar costs a model call per issue.
        case notAssessed
        /// The verdict on screen is about a DIFFERENT issue. Bug #1 on desktop:
        /// switching issues mid-flight landed verdict A under heading B, and
        /// Arm took the repo from B with the comment from A.
        case verdictIsForAnotherIssue
        /// Bug #2 on desktop: the UI showed a loud "PR #212 already implements
        /// this" banner and then let you arm anyway.
        case blocked(BlockedReason)
        case unresolvedTodo
        case tooShort
        /// Already armed in this session — the comment is posted, the label minted.
        case alreadyArmed

        /// Shown on the disabled control, so the reason is never a mystery.
        public var reason: String {
            switch self {
            case .notAssessed:
                return "Assess it against the bar first."
            case .verdictIsForAnotherIssue:
                return "This verdict is about another issue — assess this one."
            case .blocked(.openPr):
                return "A PR already implements this."
            case .blocked(.excluded):
                return "This repo never runs unattended by standing policy."
            case .blocked(.queued):
                return "Already labelled — it is in tonight's queue."
            case .blocked:
                return "Blocked — see above."
            case .unresolvedTodo:
                return "Resolve the <TODO: …> first."
            case .tooShort:
                return "Too short to be a spec — the adapter needs \(minimumCommentCharacters) characters."
            case .alreadyArmed:
                return "Already armed."
            }
        }
    }

    /// `nil` means Arm may be offered. Order matters only for which reason the
    /// reader is shown; every refusal here is also enforced by the adapter.
    public static func evaluate(
        candidate: NightQueueCandidate,
        assessment: AssessmentResponse?,
        draft: String,
        armed: Bool = false
    ) -> Refusal? {
        if armed { return .alreadyArmed }
        // `blocked` covers excluded / queued / open_pr in one. Checked before
        // the verdict so a blocked issue reads as blocked rather than unjudged.
        if let blocked = candidate.blocked { return .blocked(blocked) }
        guard let assessment else { return .notAssessed }
        guard assessment.describes(candidate) else { return .verdictIsForAnotherIssue }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.contains(unresolvedMarker) { return .unresolvedTodo }
        if text.count < minimumCommentCharacters { return .tooShort }
        return nil
    }
}
