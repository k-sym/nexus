import Foundation

/// Partner attention items — the "Needs you" collection (`GET /api/attention`,
/// proxied from the partner's `/v1/attention`; baker-internal#140, k-sym/nexus#477).
/// Wire keys are snake_case, so the shared `.nexusREST` decoder applies.
///
/// The partner is canonical: every rule (the closed verb set, the lens subset,
/// which states accept a verb) lives in its store. The client renders exactly
/// the verbs an item lists and never invents one — there is no approve or send
/// here by construction. Enums are tolerant: a kind, verb or status from a
/// future producer decodes as `.unknown` and renders as a plain row, never as a
/// decode failure.
public struct AttentionResponse: Decodable, Sendable {
    /// False when the backend has no assistant URL/key configured.
    public let configured: Bool?
    public let items: [AttentionItem]
    /// Items in `open` status store-wide, regardless of the list filter. This is
    /// the badge's half of the sum (the other half is pending approvals).
    public let open: Int?
    public let seq: Int?
    public let alertSeq: Int?
    public let generatedAt: Int?
    /// Set (with an empty `items`) when the partner was unreachable.
    public let error: String?
}

public enum AttentionKind: String, Sendable {
    case mailWaiting = "mail.waiting"
    case mailUrgent = "mail.urgent"
    case draftPending = "draft.pending"
    case meetingPrep = "meeting.prep"
    case quizPrep = "quiz.prep"
    case quizHarvest = "quiz.harvest"
    case autonomyProposal = "autonomy.proposal"
    case unknown
}

public enum AttentionStatus: String, Decodable, Sendable {
    case open
    case snoozed
    case resolving
    case resolved
    case expired
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionStatus(rawValue: raw) ?? .unknown
    }
}

/// The partner's closed verb set. `approve` and `send` cannot appear: the
/// store's CHECK constraint refuses them, so an unknown value is a future verb,
/// not a hidden send.
public enum AttentionVerb: String, Decodable, Sendable, CaseIterable {
    case draft
    case open
    case snooze
    case dismiss
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionVerb(rawValue: raw) ?? .unknown
    }
}

/// Snooze presets the partner accepts (`bin/attention.py` PRESETS).
public enum AttentionSnoozePreset: String, Sendable, CaseIterable {
    case later
    case tomorrow
    case nextWeek = "next_week"

    public var label: String {
        switch self {
        case .later: "Later today"
        case .tomorrow: "Tomorrow"
        case .nextWeek: "Next week"
        }
    }
}

/// Where an item points. The partner normalises `links` to these keys (`url`
/// arrives with slice 6b's producers; absent today).
public struct AttentionLinks: Decodable, Sendable {
    public let draftId: String?
    public let vaultPage: String?
    public let proposalId: String?
    public let url: String?
}

/// A vault page behind an item (`GET /api/attention/:id/page`): the memory the
/// producer filed under the exact title in `links.vault_page`, as markdown.
public struct AttentionPage: Decodable, Sendable, Identifiable {
    public let title: String
    public let body: String
    public let memoryId: String?
    public let itemId: String?

    /// Stable enough to drive a `sheet(item:)`: the memory id, else the item's, else the title.
    public var id: String { memoryId ?? itemId ?? title }
}

/// Epoch seconds as the partner writes them: item columns are `int(now)`, but
/// the event ledger (and anything else stamped straight from `time.time()`)
/// is a float such as `1789574428.059785`. Foundation's `Int` decode rejects a
/// non-integral number outright, which failed every detail row (each has at
/// least a `post` event), so timestamps accept either and truncate.
extension KeyedDecodingContainer {
    func decodeEpochIfPresent(forKey key: Key) throws -> Int? {
        if let whole = try? decodeIfPresent(Int.self, forKey: key) { return whole }
        guard let real = try decodeIfPresent(Double.self, forKey: key), real.isFinite else { return nil }
        return Int(real.rounded(.down))
    }
}

/// One resolve, as the partner recorded it. `result` is producer-shaped; the
/// `draft` verb writes `draft_id` into it.
public struct AttentionResolution: Decodable, Sendable {
    public let verb: AttentionVerb?
    public let by: String?
    public let surface: String?
    public let at: Int?
    public let result: [String: JSONValue]?

    enum CodingKeys: String, CodingKey { case verb, by, surface, at, result }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verb = try c.decodeIfPresent(AttentionVerb.self, forKey: .verb)
        by = try c.decodeIfPresent(String.self, forKey: .by)
        surface = try c.decodeIfPresent(String.self, forKey: .surface)
        at = try c.decodeEpochIfPresent(forKey: .at)
        result = try c.decodeIfPresent([String: JSONValue].self, forKey: .result)
    }

    public var draftId: String? { result?["draft_id"]?.string }
}

/// Append-only ledger row from the detail call. `verb` here includes
/// producer-side verbs (`post`, `renotify`, `expire`, `reconcile`, `error`) that
/// are not in the client verb set, so it stays a plain string.
public struct AttentionEvent: Decodable, Sendable {
    public let verb: String
    public let by: String?
    public let surface: String?
    /// Whole seconds; the ledger writes a float (see `decodeEpochIfPresent`).
    public let ts: Int?
    public let result: [String: JSONValue]?

    enum CodingKeys: String, CodingKey { case verb, by, surface, ts, result }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verb = try c.decodeIfPresent(String.self, forKey: .verb) ?? ""
        by = try c.decodeIfPresent(String.self, forKey: .by)
        surface = try c.decodeIfPresent(String.self, forKey: .surface)
        ts = try c.decodeEpochIfPresent(forKey: .ts)
        result = try c.decodeIfPresent([String: JSONValue].self, forKey: .result)
    }

    /// The `error` event's message, when the producer recorded one.
    public var message: String? {
        result?["error"]?.string ?? result?["message"]?.string ?? result?["detail"]?.string
    }
}

public struct AttentionItem: Decodable, Sendable, Identifiable {
    public let id: String
    /// Raw kind as the partner wrote it; `kind` is the tolerant enum view.
    public let kindName: String
    public let status: AttentionStatus
    public let title: String
    /// One line: why this needs a person.
    public let why: String?
    public let body: String?
    /// Producer-shaped reference (account, conversation, …). Free-form on the wire.
    public let source: [String: JSONValue]?
    public let links: AttentionLinks?
    public let proposedVerb: AttentionVerb?
    public let verbs: [AttentionVerb]
    /// Subset of `verbs` the glasses may offer. Never contains `open`.
    public let lensVerbs: [AttentionVerb]?
    /// `notice` | `action` once the producer sets it (slice 6b); absent = action.
    public let category: String?
    /// Project slug or badge the producer suggests for "file as a to-do" (6b); absent today.
    public let suggestedProject: String?
    public let producer: String?
    public let createdAt: Int?
    public let updatedAt: Int?
    public let snoozedUntil: Int?
    public let expiresAt: Int?
    public let seq: Int?
    public let alertSeq: Int?
    public let resolution: AttentionResolution?
    /// Only on the detail call.
    public let events: [AttentionEvent]?

    enum CodingKeys: String, CodingKey {
        case id, status, title, why, body, source, links, verbs, producer, seq, resolution, events
        case kindName = "kind"
        case proposedVerb, lensVerbs, createdAt, updatedAt, snoozedUntil, expiresAt, alertSeq
        case category, suggestedProject
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kindName = try c.decodeIfPresent(String.self, forKey: .kindName) ?? "unknown"
        status = try c.decodeIfPresent(AttentionStatus.self, forKey: .status) ?? .unknown
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        why = try c.decodeIfPresent(String.self, forKey: .why)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        source = try c.decodeIfPresent([String: JSONValue].self, forKey: .source)
        links = try c.decodeIfPresent(AttentionLinks.self, forKey: .links)
        proposedVerb = try c.decodeIfPresent(AttentionVerb.self, forKey: .proposedVerb)
        verbs = try c.decodeIfPresent([AttentionVerb].self, forKey: .verbs) ?? []
        lensVerbs = try c.decodeIfPresent([AttentionVerb].self, forKey: .lensVerbs)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        suggestedProject = try c.decodeIfPresent(String.self, forKey: .suggestedProject)
        producer = try c.decodeIfPresent(String.self, forKey: .producer)
        createdAt = try c.decodeEpochIfPresent(forKey: .createdAt)
        updatedAt = try c.decodeEpochIfPresent(forKey: .updatedAt)
        snoozedUntil = try c.decodeEpochIfPresent(forKey: .snoozedUntil)
        expiresAt = try c.decodeEpochIfPresent(forKey: .expiresAt)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        alertSeq = try c.decodeIfPresent(Int.self, forKey: .alertSeq)
        resolution = try c.decodeIfPresent(AttentionResolution.self, forKey: .resolution)
        events = try c.decodeIfPresent([AttentionEvent].self, forKey: .events)
    }

    public var kind: AttentionKind { AttentionKind(rawValue: kindName) ?? .unknown }

    /// A notice wants "seen" or "file as a to-do", never a push and never a badge
    /// count (design D19/D22a). Absent category = action.
    public var isNotice: Bool { category == "notice" }

    /// The partner accepts a verb only while the item is `open` or `snoozed`;
    /// it stores `verbs` on the item and never strips them, so a client must
    /// gate on this, not on `verbs` alone, or render buttons that 409.
    public var isActionable: Bool { status == .open || status == .snoozed }

    /// Verbs the phone may offer right now, in the partner's canonical order.
    public var offeredVerbs: [AttentionVerb] {
        guard isActionable else { return [] }
        return AttentionVerb.allCases.filter { $0 != .unknown && verbs.contains($0) }
    }

    /// The draft this item reaches: recorded by a finished `draft` verb, or
    /// linked by the producer (a `draft.pending` item).
    public var draftId: String? { resolution?.draftId ?? links?.draftId }

    /// The producer's recorded reason when a `draft` verb returned the item to
    /// open without drafting.
    public var lastErrorMessage: String? {
        events?.last(where: { $0.verb == "error" })?.message
    }

    public var sourceAccount: String? { source?["account"]?.string }
}
