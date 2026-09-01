import XCTest
@testable import NexusCore

/// Readiness workshop (baker-internal#111) on iOS.
///
/// The decoding cases are ordinary. The load-bearing ones are `ArmGate`: it is
/// the phone's copy of refusals the adapter enforces anyway, and every case
/// below is a bug the desktop version actually shipped and had to be driven in
/// a real browser to find.
final class NightQueueWorkshopTests: XCTestCase {

    // MARK: Decoding

    private let candidatesJSON = """
    {
      "configured": true,
      "unblocked": 1,
      "generated_at": 1787000000,
      "cached": false,
      "candidates": [
        {"repo": "quasar-scoreboard", "number": 3, "title": "Layout bug",
         "url": "https://github.com/k-sym/quasar-scoreboard/issues/3",
         "updated_at": "2026-08-31T09:00:00Z", "updated_ts": 1786900000,
         "labels": [], "queued": false, "excluded": false,
         "open_pr": null, "blocked": null},
        {"repo": "wisesafety", "number": 211, "title": "Training content",
         "url": "u211", "updated_at": null, "updated_ts": null,
         "labels": ["bug"], "queued": false, "excluded": false,
         "open_pr": {"number": 212, "url": "p212", "branch": "fix/issue-211-x",
                     "reason": "linked"},
         "blocked": "open_pr"},
        {"repo": "nexus", "number": 401, "title": "Stats card", "url": "u401",
         "updated_at": null, "updated_ts": null, "labels": [],
         "queued": false, "excluded": true, "open_pr": null,
         "blocked": "excluded"},
        {"repo": "selfie-wall", "number": 300, "title": "Live wall",
         "url": "u300", "updated_at": null, "updated_ts": null,
         "labels": ["night-queue"], "queued": true, "excluded": false,
         "open_pr": null, "blocked": "queued"}
      ]
    }
    """

    func testDecodesCandidatesWithEveryBlocker() throws {
        let report = try JSONDecoder.nexusREST.decode(
            NightQueueCandidatesResponse.self, from: Data(candidatesJSON.utf8))

        XCTAssertEqual(report.candidates.count, 4)
        // The count is `unblocked`, never "armable": nothing in this list has
        // been judged against the bar yet.
        XCTAssertEqual(report.unblocked, 1)

        XCTAssertNil(report.candidates[0].blocked)
        XCTAssertEqual(report.candidates[0].id, "quasar-scoreboard#3")

        XCTAssertEqual(report.candidates[1].blocked, .openPr)
        XCTAssertEqual(report.candidates[1].openPr?.number, 212)
        XCTAssertEqual(report.candidates[1].openPr?.reason, .linked)

        XCTAssertEqual(report.candidates[2].blocked, .excluded)
        XCTAssertEqual(report.candidates[3].blocked, .queued)
    }

    /// A future adapter value must not break decoding — the whole list would
    /// vanish over one unrecognised string.
    func testUnknownEnumValuesDecodeRatherThanThrow() throws {
        let json = """
        {"configured": true, "candidates": [
          {"repo": "a", "number": 1, "title": "t", "url": "u",
           "updated_at": null, "updated_ts": null, "labels": [],
           "queued": false, "excluded": false,
           "open_pr": {"number": 2, "url": "p", "branch": "b",
                       "reason": "some_future_reason"},
           "blocked": "some_future_blocker"}]}
        """
        let report = try JSONDecoder.nexusREST.decode(
            NightQueueCandidatesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(report.candidates.first?.blocked, .unknown)
        XCTAssertEqual(report.candidates.first?.openPr?.reason, .unknown)

        let verdict = """
        {"repo": "a", "number": 1, "title": "t", "url": "u", "state": "OPEN",
         "labels": [], "queued": false, "excluded": false, "open_pr": null,
         "ready": false, "assessed": true, "summary": "s",
         "criteria": [{"id": "outcome", "label": "Stated outcome",
                       "status": "future_status", "note": "n"}],
         "draft_comment": "c"}
        """
        let assessed = try JSONDecoder.nexusREST.decode(
            AssessmentResponse.self, from: Data(verdict.utf8))
        XCTAssertEqual(assessed.criteria.first?.status, .unknown)
    }

    func testDecodesReadinessBarAndFailSoftShapes() throws {
        let json = """
        {"configured": true,
         "criteria": [
           {"id": "outcome", "label": "Stated outcome",
            "requirement": "What should be true when this is done.",
            "conditional": null},
           {"id": "reachability", "label": "Reachability",
            "requirement": "Which existing screen gains the link.",
            "conditional": "user-facing work only"}],
         "bar_text": "READINESS BAR — an issue qualifies ONLY if...",
         "comment_template": "**Goal:** ...",
         "excluded_repos": ["baker-internal", "nexus"]}
        """
        let bar = try JSONDecoder.nexusREST.decode(ReadinessResponse.self, from: Data(json.utf8))
        XCTAssertEqual(bar.criteria.count, 2)
        XCTAssertEqual(bar.criteria[1].conditional, "user-facing work only")
        XCTAssertEqual(bar.excludedRepos, ["baker-internal", "nexus"])
        XCTAssertTrue(bar.barText?.hasPrefix("READINESS BAR") == true)

        // Unconfigured backend: data, not a thrown error.
        let off = try JSONDecoder.nexusREST.decode(
            ReadinessResponse.self, from: Data(#"{"configured": false, "criteria": []}"#.utf8))
        XCTAssertEqual(off.configured, false)
        XCTAssertTrue(off.criteria.isEmpty)

        let broken = try JSONDecoder.nexusREST.decode(
            NightQueueCandidatesResponse.self,
            from: Data(#"{"configured": true, "candidates": [], "error": "gh: rate limit", "stale": true}"#.utf8))
        XCTAssertEqual(broken.error, "gh: rate limit")
        XCTAssertEqual(broken.stale, true)
    }

    func testDecodesArmResponseIncludingTheClassKeyword() throws {
        let json = """
        {"repo": "quasar-scoreboard", "number": 3, "title": "Layout bug",
         "url": "https://github.com/k-sym/quasar-scoreboard/issues/3",
         "queued": true, "label": "night-queue", "comment_posted": true,
         "decision": {"class": "night-queue-arm:quasar-scoreboard",
                      "recorded": true, "promotable": false, "streak": 1}}
        """
        let armed = try JSONDecoder.nexusREST.decode(ArmResponse.self, from: Data(json.utf8))
        XCTAssertTrue(armed.commentPosted)
        XCTAssertEqual(armed.label, "night-queue")
        XCTAssertEqual(armed.decision?.armClass, "night-queue-arm:quasar-scoreboard")
        // The night-queue ledger class is permanently denylisted from auto.
        XCTAssertEqual(armed.decision?.promotable, false)

        // A ledger failure is reported alongside the success, never over it.
        let audited = """
        {"repo": "a", "number": 1, "title": "t", "url": "u", "queued": true,
         "label": "night-queue", "comment_posted": true,
         "decision": {"class": "night-queue-arm:a", "recorded": false,
                      "error": "ledger unavailable"}}
        """
        let partial = try JSONDecoder.nexusREST.decode(ArmResponse.self, from: Data(audited.utf8))
        XCTAssertTrue(partial.queued)
        XCTAssertEqual(partial.decision?.recorded, false)
        XCTAssertEqual(partial.decision?.error, "ledger unavailable")
    }

    func testDecodesTheDiscussSession() throws {
        let json = """
        {"session_id": "8f1c-…", "repo": "quasar-scoreboard", "number": 3,
         "title": "Rank column drops on narrow screens",
         "url": "https://github.com/k-sym/quasar-scoreboard/issues/3",
         "session_title": "night-queue: quasar-scoreboard#3"}
        """
        let opened = try JSONDecoder.nexusREST.decode(DiscussResponse.self, from: Data(json.utf8))
        XCTAssertEqual(opened.sessionId, "8f1c-…")
        XCTAssertEqual(opened.sessionTitle, "night-queue: quasar-scoreboard#3")
        XCTAssertEqual(opened.number, 3)
    }

    /// Opening a conversation is a POST with an effect but no GitHub write, so
    /// unlike arming it keeps the ordinary 409 meaning.
    func testDiscussKeepsTheDefaultConflictMeaning() {
        let discuss = Endpoint.discussIssue(body: Data("{}".utf8))
        XCTAssertEqual(discuss.path, "/api/night-queue/discuss")
        XCTAssertEqual(discuss.method, "POST")
        XCTAssertTrue(discuss.conflictIsBusy)
    }

    // MARK: The arm gate

    private func candidates() throws -> [String: NightQueueCandidate] {
        let report = try JSONDecoder.nexusREST.decode(
            NightQueueCandidatesResponse.self, from: Data(candidatesJSON.utf8))
        return Dictionary(uniqueKeysWithValues: report.candidates.map { ($0.id, $0) })
    }

    private func assessment(_ repo: String, _ number: Int,
                            draft: String = "**Goal:** a spec long enough to clear the length gate.")
    throws -> AssessmentResponse {
        let json = """
        {"repo": "\(repo)", "number": \(number), "title": "t", "url": "u",
         "state": "OPEN", "labels": [], "queued": false, "excluded": false,
         "open_pr": null, "ready": true, "assessed": true,
         "summary": "verdict for \(repo)#\(number)",
         "criteria": [{"id": "outcome", "label": "Stated outcome",
                       "status": "met", "note": "fine"}],
         "draft_comment": "\(draft)"}
        """
        return try JSONDecoder.nexusREST.decode(AssessmentResponse.self, from: Data(json.utf8))
    }

    func testGateOpensOnlyForAJudgedUnblockedIssue() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        let verdict = try assessment("quasar-scoreboard", 3)
        XCTAssertNil(ArmGate.evaluate(candidate: issue, assessment: verdict,
                                      draft: verdict.draftComment))
    }

    func testGateRefusesAnUnjudgedIssue() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        // Nothing in the candidate list has been judged against the bar, so an
        // issue with no verdict can never be armed however good it looks.
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: nil,
                             draft: "a comment long enough to clear the length gate entirely"),
            .notAssessed)
    }

    /// Desktop bug #2: the UI showed a loud "PR #212 already implements this"
    /// banner and then let you arm anyway. Gating on `blocked` covers all three
    /// structural refusals at once.
    func testGateRefusesEveryBlockedCandidateEvenWithACleanVerdict() throws {
        let all = try candidates()
        for (id, expected) in [("wisesafety#211", BlockedReason.openPr),
                               ("nexus#401", .excluded),
                               ("selfie-wall#300", .queued)] {
            let issue = try XCTUnwrap(all[id])
            let verdict = try assessment(issue.repo, issue.number)
            XCTAssertEqual(
                ArmGate.evaluate(candidate: issue, assessment: verdict,
                                 draft: verdict.draftComment),
                .blocked(expected),
                "\(id) must not be armable")
        }
    }

    /// Desktop bug #1, the dangerous one: an assessment takes tens of seconds,
    /// so a verdict can land after the reader has moved on. Arming on a
    /// mismatched pair took the repo from one issue and the comment from
    /// another — posting the wrong spec onto the wrong issue and labelling it.
    func testGateRefusesAVerdictAboutAnotherIssue() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        let strayVerdict = try assessment("wisesafety", 211)
        XCTAssertFalse(strayVerdict.describes(issue))
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: strayVerdict,
                             draft: strayVerdict.draftComment),
            .verdictIsForAnotherIssue)

        // Same repo, different issue: the number alone is the difference.
        let sameRepo = try assessment("quasar-scoreboard", 4)
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: sameRepo,
                             draft: sameRepo.draftComment),
            .verdictIsForAnotherIssue)
    }

    func testGateRefusesAnUnresolvedTodoAndOpensWhenItIsDecided() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        let verdict = try assessment("quasar-scoreboard", 3)

        let withTodo = "**Goal:** x\\n**Acceptance checks:** <TODO: name one> padding for length."
            .replacingOccurrences(of: "\\n", with: "\n")
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: verdict, draft: withTodo),
            .unresolvedTodo)

        // Editing the draft on the phone is the point of the sheet: resolving
        // the TODO must open the gate without a re-assessment.
        let decided = "**Goal:** x\n**Acceptance checks:** `npm test` passes and the rank column stays."
        XCTAssertNil(ArmGate.evaluate(candidate: issue, assessment: verdict, draft: decided))
    }

    func testGateMirrorsTheAdaptersLengthFloor() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        let verdict = try assessment("quasar-scoreboard", 3)

        XCTAssertEqual(ArmGate.minimumCommentCharacters, 40)
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: verdict, draft: "too short"),
            .tooShort)
        // Whitespace is not a spec.
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: verdict,
                             draft: String(repeating: " ", count: 200)),
            .tooShort)

        let exactly = String(repeating: "x", count: ArmGate.minimumCommentCharacters)
        XCTAssertNil(ArmGate.evaluate(candidate: issue, assessment: verdict, draft: exactly))
    }

    func testGateClosesAgainOnceArmed() throws {
        let issue = try XCTUnwrap(candidates()["quasar-scoreboard#3"])
        let verdict = try assessment("quasar-scoreboard", 3)
        XCTAssertEqual(
            ArmGate.evaluate(candidate: issue, assessment: verdict,
                             draft: verdict.draftComment, armed: true),
            .alreadyArmed)
    }

    func testEveryRefusalExplainsItself() {
        // A disabled control with no reason is a mystery, and this one is
        // disabled for six different reasons.
        let refusals: [ArmGate.Refusal] = [
            .notAssessed, .verdictIsForAnotherIssue, .blocked(.openPr),
            .blocked(.excluded), .blocked(.queued), .blocked(.unknown),
            .unresolvedTodo, .tooShort, .alreadyArmed,
        ]
        for refusal in refusals {
            XCTAssertFalse(refusal.reason.isEmpty, "\(refusal) must say why")
        }
    }
}

/// A 409 on the arm path is the adapter saying "the issue is closed" or "this
/// issue is already queued". Everywhere else in the app a 409 means a turn is
/// already running, and mapping arm's onto `APIError.busy` would answer a
/// question nobody asked.
final class ArmConflictEndpointTests: XCTestCase {
    func testArmOptsOutOfTheBusyMapping() throws {
        let arm = Endpoint.armIssue(body: Data("{}".utf8))
        XCTAssertFalse(arm.conflictIsBusy)
        XCTAssertEqual(arm.method, "POST")
        XCTAssertEqual(arm.path, "/api/night-queue/arm")

        // Every other endpoint keeps the existing meaning of 409.
        XCTAssertTrue(Endpoint.nightQueueCandidates.conflictIsBusy)
        XCTAssertTrue(Endpoint.assessIssue(body: Data("{}".utf8)).conflictIsBusy)
        XCTAssertTrue(Endpoint.missionControl.conflictIsBusy)
    }
}
