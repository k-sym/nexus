import XCTest
@testable import NexusCore

/// Decoding tests for the partner attention collection (#477) as the backend
/// proxies it — snake_case via `.nexusREST`. Fixtures mirror `bin/attention.py`'s
/// row shape and the backend's fail-soft envelopes.
final class AttentionModelsTests: XCTestCase {
    private let item = """
    {
      "id": "att_01",
      "kind": "mail.waiting",
      "status": "open",
      "title": "Re: Method statement for the Colchester refit",
      "why": "waiting 3.2d from jane.holloway@contractor-example.co.uk",
      "body": null,
      "source": {"producer": "inbox-nudge", "account": "ssuk", "conversation": "AAMk01"},
      "links": {"draft_id": null, "vault_page": null, "proposal_id": null},
      "proposed_verb": "draft",
      "verbs": ["draft", "open", "snooze", "dismiss"],
      "lens_verbs": ["draft", "snooze", "dismiss"],
      "dedup_key": "mail.waiting:ssuk:AAMk01",
      "producer": "inbox-nudge",
      "created_at": 1789470000,
      "updated_at": 1789470000,
      "snoozed_until": null,
      "expires_at": 1789729200,
      "seq": 12,
      "alert_seq": 4,
      "resolution": null
    }
    """

    func testDecodesFullList() throws {
        let json = """
        {"configured": true, "items": [\(item)], "open": 1, "seq": 12, "alert_seq": 4, "generated_at": 1789470100}
        """.data(using: .utf8)!
        let list = try JSONDecoder.nexusREST.decode(AttentionResponse.self, from: json)
        XCTAssertEqual(list.configured, true)
        XCTAssertEqual(list.open, 1)
        XCTAssertEqual(list.alertSeq, 4)
        XCTAssertEqual(list.items.count, 1)
        let it = list.items[0]
        XCTAssertEqual(it.kind, .mailWaiting)
        XCTAssertEqual(it.kindName, "mail.waiting")
        XCTAssertEqual(it.status, .open)
        XCTAssertEqual(it.proposedVerb, .draft)
        XCTAssertEqual(it.verbs, [.draft, .open, .snooze, .dismiss])
        XCTAssertEqual(it.lensVerbs, [.draft, .snooze, .dismiss])
        XCTAssertEqual(it.sourceAccount, "ssuk")
        XCTAssertNil(it.links?.draftId)
        XCTAssertEqual(it.expiresAt, 1_789_729_200)
        XCTAssertTrue(it.isActionable)
        XCTAssertEqual(it.offeredVerbs, [.draft, .open, .snooze, .dismiss])
        XCTAssertNil(it.draftId)
    }

    func testDecodesDetailWithEventsAndResolution() throws {
        let json = """
        {
          "id": "att_02", "kind": "draft.pending", "status": "resolved",
          "title": "Reply to Jane", "why": "drafted",
          "source": {}, "links": {"draft_id": "216ef299e734", "vault_page": null, "proposal_id": null},
          "proposed_verb": "open", "verbs": ["open", "snooze", "dismiss"], "lens_verbs": ["snooze", "dismiss"],
          "created_at": 1789470000, "updated_at": 1789470900, "seq": 20, "alert_seq": 5,
          "resolution": {"verb": "draft", "by": "ios", "surface": "phone", "at": 1789470900, "result": {"draft_id": "216ef299e734", "ok": true}},
          "events": [
            {"verb": "post", "by": "inbox-nudge", "surface": "producer", "ts": 1789470000, "result": null},
            {"verb": "draft", "by": "ios", "surface": "phone", "ts": 1789470800, "result": {"started": true}},
            {"verb": "error", "by": "ios", "surface": "phone", "ts": 1789470850, "result": {"error": "nothing usable came back"}}
          ]
        }
        """.data(using: .utf8)!
        let it = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: json)
        XCTAssertEqual(it.kind, .draftPending)
        XCTAssertEqual(it.status, .resolved)
        XCTAssertFalse(it.isActionable)
        XCTAssertEqual(it.offeredVerbs, [], "a resolved item offers no verbs even though `verbs` is populated")
        XCTAssertEqual(it.resolution?.verb, .draft)
        XCTAssertEqual(it.resolution?.surface, "phone")
        XCTAssertEqual(it.resolution?.draftId, "216ef299e734")
        XCTAssertEqual(it.draftId, "216ef299e734")
        XCTAssertEqual(it.events?.count, 3)
        XCTAssertEqual(it.events?[1].verb, "draft")
        XCTAssertEqual(it.lastErrorMessage, "nothing usable came back")
    }

    func testUnknownKindVerbAndStatusAreTolerated() throws {
        let json = """
        {
          "id": "att_03", "kind": "future.kind", "status": "archived",
          "title": "Something new", "why": "because",
          "source": {}, "links": {},
          "proposed_verb": "teleport", "verbs": ["teleport", "snooze"], "lens_verbs": [],
          "created_at": 1, "updated_at": 1, "seq": 1, "alert_seq": 1, "resolution": null
        }
        """.data(using: .utf8)!
        let it = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: json)
        XCTAssertEqual(it.kind, .unknown)
        XCTAssertEqual(it.kindName, "future.kind")
        XCTAssertEqual(it.status, .unknown)
        XCTAssertEqual(it.proposedVerb, .unknown)
        XCTAssertEqual(it.verbs, [.unknown, .snooze])
        XCTAssertFalse(it.isActionable, "an unknown status is not one the partner accepts verbs in")
        XCTAssertEqual(it.offeredVerbs, [])
        XCTAssertNil(it.links?.draftId)
    }

    func testSnoozedItemOffersItsVerbsInCanonicalOrder() throws {
        let json = """
        {"id": "att_04", "kind": "meeting.prep", "status": "snoozed", "title": "Board prep", "why": "T-1",
         "verbs": ["dismiss", "open", "snooze"], "snoozed_until": 1789516800}
        """.data(using: .utf8)!
        let it = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: json)
        XCTAssertTrue(it.isActionable)
        XCTAssertEqual(it.offeredVerbs, [.open, .snooze, .dismiss])
        XCTAssertEqual(it.snoozedUntil, 1_789_516_800)
        XCTAssertNil(it.proposedVerb)
    }

    func testFailSoftShapes() throws {
        let unconfigured = """
        {"configured": false, "items": [], "open": 0, "seq": 0, "alert_seq": 0}
        """.data(using: .utf8)!
        let a = try JSONDecoder.nexusREST.decode(AttentionResponse.self, from: unconfigured)
        XCTAssertEqual(a.configured, false)
        XCTAssertTrue(a.items.isEmpty)
        XCTAssertNil(a.error)

        let unreachable = """
        {"configured": true, "items": [], "open": 0, "seq": 0, "alert_seq": 0, "error": "connect ECONNREFUSED"}
        """.data(using: .utf8)!
        let b = try JSONDecoder.nexusREST.decode(AttentionResponse.self, from: unreachable)
        XCTAssertEqual(b.configured, true)
        XCTAssertEqual(b.error, "connect ECONNREFUSED")
    }

    func testSnoozePresetsMatchThePartner() {
        XCTAssertEqual(AttentionSnoozePreset.allCases.map(\.rawValue), ["later", "tomorrow", "next_week"])
    }
}
