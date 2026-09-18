import XCTest
@testable import NexusCore

final class RoleChildTests: XCTestCase {
    let details = #"{"childRunId":"child-1","role":"refuter","model":"fake/model","status":"completed","tokens":12,"durationMs":100,"report":"Checked the diff."}"#
    func testLiveAndReloadedMetadataMatchAndOldEventsDecode() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "Review")
        r.apply(try XCTUnwrap(JSONValue.parse(Data(#"{"type":"tool_execution_start","toolCallId":"delegate","toolName":"refute","args":{}}"#.utf8))))
        r.apply(try XCTUnwrap(JSONValue.parse(Data("{\"type\":\"tool_execution_update\",\"toolCallId\":\"delegate\",\"partialResult\":{\"content\":[],\"details\":\(details)}}".utf8))))
        XCTAssertEqual(r.streaming?.toolCalls.first?.childRun?.childRunId, "child-1")
        r.apply(try XCTUnwrap(JSONValue.parse(Data("{\"type\":\"tool_execution_end\",\"toolCallId\":\"delegate\",\"result\":{\"content\":[],\"details\":\(details)}}".utf8))))
        let live = r.streaming?.toolCalls.first?.childRun
        let history = "[{\"id\":\"a\",\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"delegate\",\"name\":\"refute\",\"status\":\"succeeded\",\"details\":\(details)}]}]"
        r.loadPersisted(try JSONDecoder().decode([PersistedMessage].self, from: Data(history.utf8)))
        XCTAssertEqual(r.messages.first?.toolCalls.first?.childRun, live)
        let old = #"[{"id":"a","role":"assistant","tool_calls":[{"id":"old","name":"read","status":"succeeded"}]}]"#
        r.loadPersisted(try JSONDecoder().decode([PersistedMessage].self, from: Data(old.utf8)))
        XCTAssertNil(r.messages.first?.toolCalls.first?.childRun)
    }
    func testChildApprovalStampsParentBlockWithoutClaimingParentToolWasApproved() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "Build")
        for line in [
            #"{"type":"tool_execution_start","toolCallId":"delegate","toolName":"build","args":{}}"#,
            #"{"kind":"approval_decision","decision":{"parentToolCallId":"delegate","childRunId":"child-1","toolCallId":"edit","outcome":"allowed","answeredBy":"human"}}"#
        ] { r.apply(try XCTUnwrap(JSONValue.parse(Data(line.utf8)))) }
        XCTAssertEqual(r.streaming?.toolCalls.first?.childApproval?.label, "approved — you")
        XCTAssertNil(r.streaming?.toolCalls.first?.approval)
        let pending = try XCTUnwrap(PendingApproval(json: try XCTUnwrap(JSONValue.parse(Data(#"{"toolCallId":"edit","childRunId":"child-1","parentToolCallId":"delegate"}"#.utf8)))))
        XCTAssertEqual(pending.childRunId, "child-1")
    }
    func testReportRemovesOnlyMatchingMetadataSuffixAndResponseDecodes() throws {
        let child = try XCTUnwrap(RoleChildRun(json: JSONValue.parse(Data(details.utf8))))
        XCTAssertEqual(child.reportText(fallback: "ignored"), "Checked the diff.")
        let response = "{\"child\":\(details),\"transcriptAvailable\":false,\"messages\":[]}"
        XCTAssertFalse(try JSONDecoder().decode(RoleChildResponse.self, from: Data(response.utf8)).transcriptAvailable)
        XCTAssertNil(RoleChildRun(json: .object(["childRunId": .string("x")])))
    }
}
