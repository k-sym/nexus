import XCTest
@testable import NexusCore

/// Decoding tests for the night-queue board (baker-internal#111) as the
/// backend proxies it from the partner adapter — snake_case via `.nexusREST`.
///
/// The load-bearing cases are about honesty: a PR the runner could not prove
/// must decode as unvalidated, and a ledger row written before the `tests`
/// column existed must decode as *unknown* rather than borrowing either
/// verdict.
final class NightQueueTests: XCTestCase {
    func testDecodesFullBoard() throws {
        let json = """
        {
          "configured": true,
          "available": true,
          "generated_at": 1787000000,
          "nights": [
            {
              "id": "20260828-010000",
              "started_at": "2026-08-28T01:00:00", "started_ts": 1787000000,
              "ended_at": "2026-08-28T03:00:00", "ended_ts": 1787007200,
              "stop_reason": "max_issues",
              "issues_planned": 2, "issues_attempted": 2, "tokens_used": 90000,
              "outcome": "worked", "prs_opened": 2, "unvalidated": 1, "failures": 0,
              "runs": [
                {"id": "r1", "repo": "selfie-wall", "issue_number": 273,
                 "branch": "nq/273-live-wall", "started_at": "2026-08-28T01:00:01",
                 "started_ts": 1787000001, "ended_at": null, "ended_ts": null,
                 "status": "pr_opened", "rounds": 1, "verdict": "approve",
                 "pr_url": "https://github.com/k-sym/selfie-wall/pull/287",
                 "tokens_used": 50000, "error": null,
                 "summary": "Added the live wall route.", "tests": "passed",
                 "issue_url": "https://github.com/k-sym/selfie-wall/issues/273"},
                {"id": "r2", "repo": "wisesafety", "issue_number": 12,
                 "branch": null, "started_at": "2026-08-28T02:00:00",
                 "started_ts": 1787003600, "ended_at": null, "ended_ts": null,
                 "status": "pr_opened", "rounds": 3, "verdict": "arbitrated_ship",
                 "pr_url": "https://github.com/k-sym/wisesafety/pull/9",
                 "tokens_used": 40000, "error": null, "summary": "",
                 "tests": "not_run", "issue_url": null}
              ]
            }
          ],
          "queue": [
            {"repo": "selfie-wall", "number": 300, "title": "Add X",
             "url": "https://github.com/k-sym/selfie-wall/issues/300",
             "updated_at": "2026-08-27T09:00:00Z", "updated_ts": 1786900000,
             "excluded": false, "readiness": "goal: X", "readiness_source": "comment"},
            {"repo": "nexus", "number": 400, "title": "Touch the surface",
             "url": "https://github.com/k-sym/nexus/issues/400",
             "updated_at": null, "updated_ts": null,
             "excluded": true, "readiness": null, "readiness_source": null}
          ],
          "queue_error": null, "queue_stale": false,
          "open_prs": [
            {"repo": "selfie-wall", "number": 287, "title": "night-queue: Add X",
             "url": "https://github.com/k-sym/selfie-wall/pull/287",
             "created_at": "2026-08-28T06:12:35Z", "created_ts": 1787897555,
             "is_draft": false}
          ],
          "open_prs_error": null, "open_prs_stale": false
        }
        """.data(using: .utf8)!

        let board = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: json)
        XCTAssertEqual(board.configured, true)
        XCTAssertEqual(board.available, true)
        XCTAssertEqual(board.generatedAt, 1_787_000_000)

        let night = try XCTUnwrap(board.nights.first)
        XCTAssertEqual(night.id, "20260828-010000")
        XCTAssertEqual(night.outcome, .worked)
        XCTAssertEqual(night.stopReason, "max_issues")
        XCTAssertEqual(night.prsOpened, 2)
        XCTAssertEqual(night.unvalidated, 1)
        XCTAssertEqual(night.failures, 0)
        XCTAssertNil(night.plan)  // list stays light; the plan is detail-only

        let proven = night.runs[0]
        XCTAssertEqual(proven.tests, .passed)
        XCTAssertEqual(proven.verdict, "approve")
        XCTAssertEqual(proven.issueUrl, "https://github.com/k-sym/selfie-wall/issues/273")
        XCTAssertFalse(proven.isUnvalidatedPR)

        let unproven = night.runs[1]
        XCTAssertEqual(unproven.tests, .notRun)
        XCTAssertNil(unproven.branch)
        // The whole point of the card: this PR is a draft, not a result.
        XCTAssertTrue(unproven.isUnvalidatedPR)

        XCTAssertEqual(board.queue[0].readinessSource, "comment")
        XCTAssertFalse(board.queue[0].excluded)
        XCTAssertTrue(board.queue[1].excluded)
        XCTAssertEqual(board.openPrs[0].number, 287)
        XCTAssertFalse(board.openPrs[0].isDraft)
    }

    func testAQuietNightDecodesAsQuiet() throws {
        let json = """
        {
          "available": true,
          "nights": [
            {"id": "20260826-010000", "started_at": "2026-08-26T01:00:00",
             "started_ts": 1786800000, "ended_at": "2026-08-26T01:00:01",
             "ended_ts": 1786800001, "stop_reason": "drained",
             "issues_planned": 0, "issues_attempted": 0, "tokens_used": 0,
             "outcome": "quiet", "prs_opened": 0, "unvalidated": 0,
             "failures": 0, "runs": []}
          ],
          "queue": [], "open_prs": []
        }
        """.data(using: .utf8)!
        let board = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: json)
        XCTAssertEqual(board.nights[0].outcome, .quiet)
        XCTAssertTrue(board.nights[0].runs.isEmpty)
    }

    func testAPreMigrationRowIsUnknownNotNotRun() throws {
        // A ledger row written before the `tests` column existed. It must not
        // borrow either verdict — but it is still an unproven PR.
        let json = """
        {
          "available": true,
          "nights": [
            {"id": "n", "started_at": null, "started_ts": null, "ended_at": null,
             "ended_ts": null, "stop_reason": "drained", "issues_planned": 1,
             "issues_attempted": 1, "tokens_used": 10, "outcome": "worked",
             "prs_opened": 1, "unvalidated": 1, "failures": 0,
             "runs": [
               {"id": "r", "repo": "selfie-wall", "issue_number": 1, "branch": null,
                "started_at": null, "started_ts": null, "ended_at": null,
                "ended_ts": null, "status": "pr_opened", "rounds": 0,
                "verdict": null, "pr_url": "https://x/1", "tokens_used": 10,
                "error": null, "summary": "", "tests": null, "issue_url": null}
             ]}
          ],
          "queue": [], "open_prs": []
        }
        """.data(using: .utf8)!
        let board = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: json)
        let run = board.nights[0].runs[0]
        XCTAssertNil(run.tests)
        XCTAssertNotEqual(run.tests, .notRun)
        XCTAssertTrue(run.isUnvalidatedPR)
        XCTAssertEqual(NightTestsBadgeLabels.unknown, "tests unknown")
    }

    func testDetailCarriesThePlan() throws {
        let json = """
        {
          "id": "20260828-010000", "started_at": null, "started_ts": null,
          "ended_at": null, "ended_ts": null, "stop_reason": "drained",
          "issues_planned": 1, "issues_attempted": 1, "tokens_used": 100,
          "outcome": "worked", "prs_opened": 1, "unvalidated": 0, "failures": 0,
          "runs": [],
          "plan": {
            "selected": [{"repo": "selfie-wall", "number": 273, "title": "Live wall",
                          "model": "sonnet", "budget_tokens": 300000,
                          "rationale": "meets the bar"}],
            "parked": [{"repo": "wise-app", "number": 8, "reason": "no acceptance check"}],
            "excluded": [{"repo": "nexus", "number": 400, "title": "self-modification"}]
          }
        }
        """.data(using: .utf8)!
        let night = try JSONDecoder.nexusREST.decode(Night.self, from: json)
        let plan = try XCTUnwrap(night.plan)
        XCTAssertEqual(plan.selected[0].model, "sonnet")
        XCTAssertEqual(plan.selected[0].budgetTokens, 300_000)
        XCTAssertEqual(plan.parked[0].reason, "no acceptance check")
        XCTAssertEqual(plan.excluded[0].repo, "nexus")
    }

    func testFailSoftAndFutureValuesTolerated() throws {
        // A future adapter outcome or test state must not break decoding.
        let future = """
        {
          "available": true,
          "nights": [
            {"id": "n", "started_at": null, "started_ts": null, "ended_at": null,
             "ended_ts": null, "stop_reason": null, "issues_planned": 0,
             "issues_attempted": 0, "tokens_used": 0, "outcome": "hibernating",
             "prs_opened": 0, "unvalidated": 0, "failures": 0,
             "runs": [
               {"id": "r", "repo": "x", "issue_number": 1, "branch": null,
                "started_at": null, "started_ts": null, "ended_at": null,
                "ended_ts": null, "status": "quarantined", "rounds": 0,
                "verdict": null, "pr_url": null, "tokens_used": 0, "error": null,
                "summary": "", "tests": "skipped", "issue_url": null}
             ]}
          ],
          "queue": [], "open_prs": []
        }
        """.data(using: .utf8)!
        let board = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: future)
        XCTAssertEqual(board.nights[0].outcome, .unknown)
        XCTAssertEqual(board.nights[0].runs[0].tests, .unknown)

        // Unconfigured / no-ledger-yet / adapter-down shapes from the proxy.
        let unconfigured = """
        {"configured": false, "available": false, "nights": [], "queue": [], "open_prs": []}
        """.data(using: .utf8)!
        let empty = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: unconfigured)
        XCTAssertEqual(empty.configured, false)
        XCTAssertEqual(empty.available, false)
        XCTAssertTrue(empty.nights.isEmpty)

        let down = """
        {"configured": true, "available": false, "nights": [], "queue": [],
         "open_prs": [], "error": "connect ECONNREFUSED"}
        """.data(using: .utf8)!
        let failed = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: down)
        XCTAssertEqual(failed.error, "connect ECONNREFUSED")

        // A stale section: the last good answer, flagged as such.
        let stale = """
        {"configured": true, "available": true, "nights": [],
         "queue": [{"repo": "a", "number": 1, "title": "t", "url": "u",
                    "updated_at": null, "updated_ts": null, "excluded": false,
                    "readiness": null, "readiness_source": null}],
         "queue_error": "gh: API rate limit", "queue_stale": true, "open_prs": []}
        """.data(using: .utf8)!
        let cached = try JSONDecoder.nexusREST.decode(NightQueueResponse.self, from: stale)
        XCTAssertEqual(cached.queueStale, true)
        XCTAssertEqual(cached.queueError, "gh: API rate limit")
        XCTAssertEqual(cached.queue.count, 1)
    }
}

/// The badge copy lives in the app target, which NexusCore tests cannot import.
/// Pinning the one string that must never drift keeps the contract visible
/// here: an absent test result is *unknown*, not a verdict.
enum NightTestsBadgeLabels {
    static let unknown = "tests unknown"
}
