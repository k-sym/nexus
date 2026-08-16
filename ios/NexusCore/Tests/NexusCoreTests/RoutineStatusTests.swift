import XCTest
@testable import NexusCore

/// Decoding tests for the routine fleet payload (baker-internal#82) as the
/// backend proxies it from the partner adapter — snake_case via `.nexusREST`.
final class RoutineStatusTests: XCTestCase {
    func testDecodesFullReport() throws {
        let json = """
        {
          "configured": true,
          "generated_at": 1786000100,
          "routines": [
            {
              "name": "morning-brief",
              "label": "com.k-sym.partner.morning-brief",
              "schedule": [{"hour": 7, "minute": 5}],
              "schedule_display": "daily 07:05",
              "last_run": {"started": 1786000000, "ended": 1786000060, "rc": 0, "timed_out": false, "source": "status"},
              "health": "ok",
              "last_expected": 1786000000,
              "next_due": 1786086400
            },
            {
              "name": "team-pulse-morning",
              "label": "com.k-sym.partner.team-pulse-morning",
              "schedule": [{"hour": 8, "minute": 5, "weekday": 1}],
              "schedule_display": "Mon Tue Wed Thu Fri 08:05",
              "last_run": null,
              "health": "stale",
              "last_expected": 1786000000,
              "next_due": null
            }
          ]
        }
        """.data(using: .utf8)!

        let report = try JSONDecoder.nexusREST.decode(RoutinesResponse.self, from: json)
        XCTAssertEqual(report.configured, true)
        XCTAssertEqual(report.generatedAt, 1_786_000_100)
        XCTAssertEqual(report.routines.count, 2)

        let brief = report.routines[0]
        XCTAssertEqual(brief.name, "morning-brief")
        XCTAssertEqual(brief.scheduleDisplay, "daily 07:05")
        XCTAssertEqual(brief.health, .ok)
        XCTAssertEqual(brief.lastRun?.rc, 0)
        XCTAssertEqual(brief.lastRun?.timedOut, false)
        XCTAssertEqual(brief.lastRun?.source, "status")
        XCTAssertEqual(brief.nextDue, 1_786_086_400)
        XCTAssertNil(brief.logTail)

        let pulse = report.routines[1]
        XCTAssertEqual(pulse.health, .stale)
        XCTAssertNil(pulse.lastRun)
        XCTAssertNil(pulse.nextDue)
    }

    func testDecodesDetailWithLogTail() throws {
        let json = """
        {
          "name": "reflect",
          "label": "com.k-sym.partner.reflect",
          "schedule": [{"hour": 2, "minute": 30}],
          "schedule_display": "daily 02:30",
          "last_run": {"started": 1786000000, "ended": 1786001200, "rc": 143, "timed_out": true, "source": "status"},
          "health": "failed",
          "last_expected": 1786000000,
          "next_due": 1786086400,
          "log_tail": ["line 1", "line 2"]
        }
        """.data(using: .utf8)!

        let detail = try JSONDecoder.nexusREST.decode(Routine.self, from: json)
        XCTAssertEqual(detail.health, .failed)
        XCTAssertEqual(detail.lastRun?.timedOut, true)
        XCTAssertEqual(detail.logTail, ["line 1", "line 2"])
    }

    func testUnknownHealthAndFailSoftShapesTolerated() throws {
        // A future adapter health value must not break decoding.
        let future = """
        {
          "routines": [
            {"name": "x", "label": "com.k-sym.partner.x", "schedule": [],
             "schedule_display": "daily 00:00", "last_run": null,
             "health": "paused", "last_expected": null, "next_due": null}
          ]
        }
        """.data(using: .utf8)!
        let report = try JSONDecoder.nexusREST.decode(RoutinesResponse.self, from: future)
        XCTAssertEqual(report.routines[0].health, .unknown)
        XCTAssertNil(report.configured)

        // Unconfigured / adapter-down shapes from the nexus proxy.
        let unconfigured = """
        {"configured": false, "routines": []}
        """.data(using: .utf8)!
        let empty = try JSONDecoder.nexusREST.decode(RoutinesResponse.self, from: unconfigured)
        XCTAssertEqual(empty.configured, false)
        XCTAssertTrue(empty.routines.isEmpty)

        let down = """
        {"configured": true, "routines": [], "error": "connect ECONNREFUSED"}
        """.data(using: .utf8)!
        let failed = try JSONDecoder.nexusREST.decode(RoutinesResponse.self, from: down)
        XCTAssertEqual(failed.error, "connect ECONNREFUSED")
    }
}
