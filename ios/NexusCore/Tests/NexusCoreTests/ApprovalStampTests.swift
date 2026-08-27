import XCTest
@testable import NexusCore

/// Inline approval decisions (#374): a gated tool call carries how its gate
/// settled, on both the live stream and the persisted-history path, and the
/// label always names the decider — a partner-decided gate must never read
/// like one the user tapped.
final class ApprovalStampTests: XCTestCase {

    private func apply(_ json: String, to reducer: inout TranscriptReducer) throws {
        let value = try XCTUnwrap(JSONValue.parse(Data(json.utf8)), "unparseable fixture line")
        reducer.apply(value)
    }

    func testLiveDecisionStampsItsToolCall() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "run npm --version")
        try apply(#"{"type":"tool_execution_start","toolCallId":"gated-1","toolName":"bash","args":{"command":"npm --version"}}"#, to: &r)
        try apply(#"{"kind":"approval_decision","decision":{"threadId":"t","toolCallId":"gated-1","toolName":"bash","inputSummary":"npm --version","outcome":"allowed","answeredBy":"human","decidedAt":"2026-08-27T07:12:00.000Z"}}"#, to: &r)

        let tool = try XCTUnwrap(r.streaming?.toolCalls.first)
        let stamp = try XCTUnwrap(tool.approval)
        XCTAssertEqual(stamp.outcome, .allowed)
        XCTAssertEqual(stamp.answeredBy, "human")
        XCTAssertEqual(stamp.label, "approved — you")
        // The stamp decorates the call; it must not disturb execution state.
        XCTAssertEqual(tool.status, .running)
    }

    func testDenialCarriesReasonAndDecider() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "run rm")
        try apply(#"{"type":"tool_execution_start","toolCallId":"gated-2","toolName":"bash","args":{"command":"rm -rf /"}}"#, to: &r)
        try apply(#"{"kind":"approval_decision","decision":{"threadId":"t","toolCallId":"gated-2","toolName":"bash","inputSummary":"rm -rf /","outcome":"denied","answeredBy":"partner","reason":"destructive","decidedAt":"2026-08-27T07:13:00.000Z"}}"#, to: &r)

        let stamp = try XCTUnwrap(r.streaming?.toolCalls.first?.approval)
        XCTAssertEqual(stamp.outcome, .denied)
        XCTAssertEqual(stamp.reason, "destructive")
        XCTAssertEqual(stamp.label, "denied — partner")
    }

    func testTimeoutLabelReadsAutoDenied() {
        let stamp = ToolApprovalStamp(outcome: .denied, answeredBy: "timeout")
        XCTAssertEqual(stamp.label, "auto-denied — timed out")
    }

    func testUnknownDeciderDegradesToItsRawName() {
        let stamp = ToolApprovalStamp(outcome: .allowed, answeredBy: "delegate")
        XCTAssertEqual(stamp.label, "approved — delegate")
    }

    func testMalformedDecisionIsIgnoredNotFatal() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "x")
        try apply(#"{"type":"tool_execution_start","toolCallId":"gated-3","toolName":"bash","args":{}}"#, to: &r)
        try apply(#"{"kind":"approval_decision","decision":{"toolCallId":"gated-3","outcome":"maybe"}}"#, to: &r)
        try apply(#"{"kind":"approval_decision"}"#, to: &r)
        XCTAssertNil(r.streaming?.toolCalls.first?.approval)
    }

    func testPersistedHistoryCarriesTheStamp() throws {
        let json = #"""
        [{"id":"m1","role":"assistant","content":"done","tool_calls":[
          {"id":"gated-1","name":"bash","args":{"command":"npm --version"},"status":"succeeded","result":"11.6.2",
           "approval":{"outcome":"allowed","answeredBy":"human","decidedAt":"2026-08-27T07:12:00.000Z"}},
          {"id":"plain-1","name":"read","args":{"path":"/x"},"status":"succeeded","result":"ok"}
        ]}]
        """#
        let persisted = try JSONDecoder().decode([PersistedMessage].self, from: Data(json.utf8))
        var r = TranscriptReducer()
        r.loadPersisted(persisted)

        let tools = try XCTUnwrap(r.messages.first?.toolCalls)
        let stamp = try XCTUnwrap(tools[0].approval)
        XCTAssertEqual(stamp.outcome, .allowed)
        XCTAssertEqual(stamp.label, "approved — you")
        // Absence means "no gate": a policy-allowed read carries no stamp.
        XCTAssertNil(tools[1].approval)
    }
}
