import XCTest
@testable import NexusCore

final class M2StreamTests: XCTestCase {

    /// Replay a captured NDJSON fixture through a reducer, after a startTurn.
    private func replay(_ name: String, prompt: String = "Hi") throws -> TranscriptReducer {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "ndjson", subdirectory: "Fixtures"),
            "missing fixture \(name).ndjson")
        let text = try String(contentsOf: url, encoding: .utf8)
        var reducer = TranscriptReducer()
        reducer.startTurn(prompt: prompt)
        for line in text.split(separator: "\n") {
            let data = Data(line.utf8)
            if let value = JSONValue.parse(data) {
                reducer.apply(value)
            }
        }
        return reducer
    }

    func testTextStreamAssembles() throws {
        let r = try replay("stream_text")
        XCTAssertNil(r.streaming, "run_end should finalize the streaming bubble")
        XCTAssertEqual(r.status, .idle)
        XCTAssertEqual(r.messages.count, 2)
        XCTAssertEqual(r.messages[0].role, .user)
        XCTAssertEqual(r.messages[0].content, "Hi")
        let assistant = r.messages[1]
        XCTAssertEqual(assistant.role, .assistant)
        XCTAssertEqual(assistant.content, "Hello, world")
        XCTAssertEqual(assistant.provider, "anthropic")
        XCTAssertEqual(assistant.model, "claude-opus-4-8")
        XCTAssertFalse(assistant.isStreaming)
        XCTAssertEqual(r.contextUsage?.tokens, 1200)
        XCTAssertEqual(r.contextUsage?.contextWindow, 200000)
    }

    func testToolStreamPreservesNestedSnakeArgsAndParagraphBreak() throws {
        let r = try replay("stream_tools")
        XCTAssertNil(r.streaming)
        let assistant = try XCTUnwrap(r.messages.last)
        // Paragraph break inserted between prose and post-tool prose.
        XCTAssertEqual(assistant.content, "Let me check the file.\n\nDone.")
        XCTAssertEqual(assistant.toolCalls.count, 1)
        let tool = assistant.toolCalls[0]
        XCTAssertEqual(tool.name, "Read")
        XCTAssertEqual(tool.status, .completed)
        XCTAssertEqual(tool.result, "127.0.0.1 localhost")
        // The nested snake_case arg key must survive (plain JSON decode, not
        // .convertFromSnakeCase).
        XCTAssertEqual(tool.args["file_path"]?.string, "/etc/hosts")
    }

    func testThinkingThenText() throws {
        let r = try replay("stream_thinking")
        let assistant = try XCTUnwrap(r.messages.last)
        XCTAssertEqual(assistant.thinking, "Hmm, let me think.")
        XCTAssertEqual(assistant.content, "The answer is 42.")
    }

    func testErrorFinalizesPartialAndSetsError() throws {
        let r = try replay("stream_error")
        XCTAssertEqual(r.status, .error)
        XCTAssertEqual(r.errorText, "provider exploded")
        XCTAssertNil(r.streaming)
        let assistant = try XCTUnwrap(r.messages.last)
        XCTAssertEqual(assistant.content, "Partial ")
        XCTAssertTrue(assistant.isError)
    }

    func testDisconnectInterruptsRunningTool() throws {
        var r = TranscriptReducer()
        r.startTurn(prompt: "go")
        let lines = [
            #"{"kind":"run_start","run":{"runId":"r5","threadId":"t1","startedAt":"2026-07-24T12:00:00.000Z"}}"#,
            #"{"type":"tool_execution_start","toolCallId":"c1","toolName":"Bash","args":{}}"#,
        ]
        for line in lines { r.apply(try XCTUnwrap(JSONValue.parse(Data(line.utf8)))) }
        // Stream drops before run_end.
        r.finishByDisconnect()
        let assistant = try XCTUnwrap(r.messages.last)
        XCTAssertEqual(assistant.toolCalls.first?.status, .interrupted)
        XCTAssertNil(r.streaming)
    }

    func testPersistedRoundTrips() throws {
        let json = Data("""
        {
          "thread": { "id": "t1", "project_id": "p1", "title": "Auth work", "git_branch": "main", "created_at": "x", "updated_at": "y", "archived_at": null },
          "cwd": "/repo",
          "messages": [
            { "id": "m1", "role": "user", "content": "hello", "timestamp": 1 },
            { "id": "m2", "role": "assistant", "content": "hi there", "thinking": null,
              "tool_calls": [ { "id": "c1", "name": "Read", "args": { "file_path": "/x" }, "status": "succeeded", "queuedAt": 1, "partialOutput": "", "result": "ok" } ],
              "model": "claude-opus-4-8", "provider": "anthropic", "isError": false, "timestamp": 2 },
            { "id": "m3", "role": "toolResult", "toolCallId": "c1", "toolName": "Read", "content": "ok", "isError": false, "timestamp": 3 }
          ]
        }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(ThreadDetail.self, from: json)
        XCTAssertEqual(detail.thread.projectId, "p1")
        XCTAssertEqual(detail.thread.gitBranch, "main")
        XCTAssertEqual(detail.messages.count, 3)

        var reducer = TranscriptReducer()
        reducer.loadPersisted(detail.messages)
        // toolResult row dropped; user + assistant kept.
        XCTAssertEqual(reducer.messages.count, 2)
        let assistant = reducer.messages[1]
        XCTAssertEqual(assistant.content, "hi there")
        XCTAssertEqual(assistant.toolCalls.first?.status, .completed)
        XCTAssertEqual(assistant.toolCalls.first?.args["file_path"]?.string, "/x")
    }
}
