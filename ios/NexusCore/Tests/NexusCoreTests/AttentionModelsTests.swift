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

    /// The partner's ledger stamps events with `time.time()` — a float such as
    /// `1789574428.059785` — while item columns are `int(now)`. Every real
    /// detail row carries at least a `post` event, so an integer-only `ts`
    /// failed the whole detail decode ("The server sent an unexpected
    /// response") and the draft poll never saw the item leave `resolving`.
    func testDetailDecodesFloatEventTimestamps() throws {
        let json = """
        {
          "id": "558c045b1702", "kind": "mail.urgent", "status": "resolved",
          "title": "PaulDyster@hill.co.uk — Fw: Report", "why": "[ssuk] arrived today",
          "source": {"account": "ssuk", "ref": "AAQk01", "url": null},
          "links": {"draft_id": "29a9a42f13e0", "vault_page": null, "proposal_id": null},
          "proposed_verb": "draft", "verbs": ["draft", "snooze", "dismiss"], "lens_verbs": ["draft", "snooze", "dismiss"],
          "created_at": 1789574428, "updated_at": 1789579125, "seq": 13, "alert_seq": 7,
          "resolution": {"verb": "draft", "by": "ios", "surface": "phone", "at": 1789579125.5, "result": {"draft_id": "29a9a42f13e0"}},
          "events": [
            {"verb": "post", "by": "producer", "surface": "producer", "ts": 1789574428.059785, "result": null},
            {"verb": "draft", "by": "ios", "surface": "phone", "ts": 1789579089.2, "result": {"started": true}},
            {"verb": "draft", "by": "ios", "surface": "phone", "ts": 1789579125.473543, "result": {"draft_id": "29a9a42f13e0"}}
          ]
        }
        """.data(using: .utf8)!
        let it = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: json)
        XCTAssertEqual(it.status, .resolved)
        XCTAssertEqual(it.events?.count, 3)
        XCTAssertEqual(it.events?.first?.ts, 1789574428)
        XCTAssertEqual(it.resolution?.at, 1789579125)
        XCTAssertEqual(it.draftId, "29a9a42f13e0")
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

    // Slice 6c (design D32–D38): the 6b contract on the phone.
    func testSixBKindsCloseVerbAndCleanupKeyDecode() throws {
        let pr = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_pr", "kind": "pr.review", "status": "open", "category": "action",
         "title": "#212 Tighten the poll", "why": "RISKY — touches the cursor",
         "links": {"draft_id": null, "vault_page": null, "proposal_id": null, "url": "https://github.com/k-sym/nexus/pull/212"},
         "proposed_verb": "open", "verbs": ["open", "close", "snooze", "dismiss"], "lens_verbs": ["dismiss"],
         "dedup_key": "pr:k-sym/nexus#212", "suggested_project": "nexus", "seq": 1, "alert_seq": 1}
        """.data(using: .utf8)!)
        XCTAssertEqual(pr.kind, .prReview)
        XCTAssertEqual(pr.verbs, [.open, .close, .snooze, .dismiss])
        XCTAssertEqual(pr.offeredVerbs, [.open, .close, .snooze, .dismiss], "close is offered where listed, in the case order")
        XCTAssertEqual(pr.linkURL?.absoluteString, "https://github.com/k-sym/nexus/pull/212")
        XCTAssertEqual(pr.slowVerb, .close)
        XCTAssertFalse(pr.isCleanupApproval)
        XCTAssertFalse(pr.isNotice)
        XCTAssertEqual(pr.suggestedProject, "nexus")
        XCTAssertTrue(AttentionVerb.close.isSlow)
        XCTAssertFalse(AttentionVerb.dismiss.isSlow)

        let looksGood = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_ok", "kind": "pr.review", "status": "open", "title": "#219 ok", "verbs": ["open", "dismiss"], "lens_verbs": ["dismiss"]}
        """.data(using: .utf8)!)
        XCTAssertEqual(looksGood.offeredVerbs, [.open, .dismiss], "close is never invented for a LOOKS GOOD item")

        let cleanup = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_cl", "kind": "recon.decision", "status": "open", "title": "Cleanup awaiting approval",
         "links": {"draft_id": null, "vault_page": "Gap Report 2026-08", "proposal_id": null},
         "verbs": ["open", "snooze", "dismiss"], "lens_verbs": ["dismiss"], "dedup_key": "recon:2026-08:cleanup"}
        """.data(using: .utf8)!)
        XCTAssertEqual(cleanup.kind, .reconDecision)
        XCTAssertTrue(cleanup.isCleanupApproval)
        XCTAssertEqual(cleanup.slowVerb, .draft, "only pr.review can be closing")
        let question = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_q", "kind": "recon.decision", "status": "open", "title": "AWS lines", "verbs": ["open", "dismiss"], "dedup_key": "recon:2026-08:aws-lines"}
        """.data(using: .utf8)!)
        XCTAssertFalse(question.isCleanupApproval, "a question is not the cleanup item")
        for key in ["other:cleanup", "recon:cleanup", ":cleanup", "recon:2026-08:cleanup-list"] {
            let odd = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
            {"id": "o", "kind": "recon.decision", "status": "open", "title": "x", "verbs": ["dismiss"], "dedup_key": "\(key)"}
            """.data(using: .utf8)!)
            XCTAssertFalse(odd.isCleanupApproval, "\(key) is not the skill's key")
        }

        let notice = try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_n", "kind": "night.summary", "status": "open", "category": "notice", "title": "Night summary",
         "proposed_verb": "dismiss", "verbs": ["open", "dismiss"], "lens_verbs": ["dismiss"]}
        """.data(using: .utf8)!)
        XCTAssertEqual(notice.kind, .nightSummary)
        XCTAssertTrue(notice.isNotice)
        XCTAssertEqual(notice.offeredVerbs, [.open, .dismiss])
        for raw in ["brief.morning", "evening.triage", "recon.update", "system.alert"] {
            XCTAssertNotEqual(AttentionKind(rawValue: raw), nil, raw)
        }
        XCTAssertNil(try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "att_j", "kind": "pr.review", "status": "open", "title": "x", "links": {"url": "javascript:alert(1)"}, "verbs": []}
        """.data(using: .utf8)!).linkURL, "only http(s) urls open")
    }

    func testResolutionResultsForCloseApproveAndFile() throws {
        let closed = try JSONDecoder.nexusREST.decode(AttentionResolution.self, from: """
        {"verb": "close", "by": "ios", "surface": "phone", "at": 1789470000, "result": {"closed": "https://github.com/k-sym/nexus/pull/212", "by": "ios"}}
        """.data(using: .utf8)!)
        XCTAssertEqual(closed.verb, .close)
        XCTAssertEqual(closed.closedUrl, "https://github.com/k-sym/nexus/pull/212")
        XCTAssertEqual(closed.closedURL?.absoluteString, "https://github.com/k-sym/nexus/pull/212")
        XCTAssertFalse(closed.approved)
        let odd = try JSONDecoder.nexusREST.decode(AttentionResolution.self, from: """
        {"verb": "close", "by": "ios", "surface": "phone", "at": 1789470000, "result": {"closed": "javascript:alert(1)"}}
        """.data(using: .utf8)!)
        XCTAssertEqual(odd.closedUrl, "javascript:alert(1)")
        XCTAssertNil(odd.closedURL, "only http(s) results open")
        let approved = try JSONDecoder.nexusREST.decode(AttentionResolution.self, from: """
        {"verb": "dismiss", "by": "ios", "surface": "phone", "at": 1789470000.5, "result": {"approved": true}}
        """.data(using: .utf8)!)
        XCTAssertTrue(approved.approved)
        XCTAssertNil(approved.closedUrl)
        let filed = try JSONDecoder.nexusREST.decode(AttentionResolution.self, from: """
        {"verb": "dismiss", "by": "ios", "surface": "phone", "at": 1789470000, "result": {"filed_as": "thread-1"}}
        """.data(using: .utf8)!)
        XCTAssertEqual(filed.filedAs, "thread-1")
        XCTAssertFalse(filed.approved, "a filed_as is not approval")
    }

    // Slice 6d: the latest message behind a mail item.
    func testThreadDecodesAndAMailItemKnowsItIsOne() throws {
        let thread = try JSONDecoder.nexusREST.decode(AttentionThread.self, from: """
        {"item_id": "att_01", "messages": [{"account": "ssuk", "id": "AAMk-msg", "thread": "AAMk01",
          "from": "jane.holloway@contractor-example.co.uk", "from_name": "Jane Holloway",
          "subject": "Re: Method statement", "date": "2026-09-16T12:48:21Z",
          "body": "Hi Keith, any news on the method statement?"}]}
        """.data(using: .utf8)!)
        XCTAssertEqual(thread.itemId, "att_01")
        let m = try XCTUnwrap(thread.latest)
        XCTAssertEqual(m.senderLine, "Jane Holloway <jane.holloway@contractor-example.co.uk>")
        XCTAssertEqual(m.sentAt?.timeIntervalSince1970, 1_789_562_901)
        XCTAssertTrue(m.body.hasPrefix("Hi Keith"))
        XCTAssertFalse(m.needsMore)
        let manyLines = try JSONDecoder.nexusREST.decode(AttentionThread.self, from: """
        {"item_id": "x", "messages": [{"from": "a@x.com", "body": "\(Array(repeating: "line", count: 14).joined(separator: "\\n"))"}]}
        """.data(using: .utf8)!)
        XCTAssertTrue(manyLines.latest?.needsMore == true, "13+ short lines still need More")
        let longWrapped = try JSONDecoder.nexusREST.decode(AttentionThread.self, from: """
        {"item_id": "x", "messages": [{"from": "a@x.com", "body": "\(String(repeating: "word ", count: 120))"}]}
        """.data(using: .utf8)!)
        XCTAssertTrue(longWrapped.latest?.needsMore == true)
        let bare = try JSONDecoder.nexusREST.decode(AttentionThread.self, from: """
        {"item_id": "x", "messages": [{"from": "someone@x.com", "body": "text"}]}
        """.data(using: .utf8)!)
        XCTAssertEqual(bare.latest?.senderLine, "someone@x.com")
        XCTAssertNil(bare.latest?.sentAt)

        let list = try JSONDecoder.nexusREST.decode(AttentionResponse.self, from: """
        {"items": [\(item)], "open": 1}
        """.data(using: .utf8)!)
        XCTAssertTrue(list.items[0].isMail)
        XCTAssertFalse(try JSONDecoder.nexusREST.decode(AttentionItem.self, from: """
        {"id": "m", "kind": "meeting.prep", "status": "open", "title": "x"}
        """.data(using: .utf8)!).isMail)
    }

    func testSnoozePresetsMatchThePartner() {
        XCTAssertEqual(AttentionSnoozePreset.allCases.map(\.rawValue), ["later", "tomorrow", "next_week"])
    }
}
