import XCTest
@testable import NexusCore

/// Covers the M6 assistant surface's two decode gotchas — mixed snake/camel keys
/// (plain decoder + explicit CodingKeys) and the Hermes transcript's OPTIONAL
/// message `id` (synthesized index id) — plus the assistant stream replay.
final class AssistantDecodingTests: XCTestCase {

    // MARK: Session list rows (list + create/patch shapes)

    func testSessionsResponseDecodesLocalAndRemoteRows() throws {
        // Local rows carry snake_case DB columns; remote rows add camelCase
        // `remoteOnly`/`source`/`latestRun`. A single plain decode must handle both.
        let json = Data("""
        {
          "sessions": [
            {
              "id": "s1", "title": "Local one", "remote_session_id": "rem-1",
              "remote_conversation_key": null, "status": "idle", "last_run_id": "r1",
              "last_response_id": null, "created_at": "2026-07-28T10:00:00.000Z",
              "updated_at": "2026-07-28T12:00:00.000Z", "archived_at": null,
              "remoteOnly": false,
              "latestRun": { "id": "r1", "session_id": "s1", "kind": "chat", "status": "running",
                             "input": "hi", "output": "", "error": null,
                             "started_at": "2026-07-28T12:00:00.000Z", "completed_at": null,
                             "updated_at": "2026-07-28T12:00:00.000Z" }
            },
            {
              "id": "remote:abc", "title": "TUI session", "remote_session_id": "abc",
              "status": "remote", "remoteOnly": true, "source": "tui",
              "created_at": "2026-07-28T09:00:00.000Z", "updated_at": "2026-07-28T11:00:00.000Z",
              "archived_at": null, "latestRun": null
            }
          ]
        }
        """.utf8)
        let res = try JSONDecoder.nexusCamel.decode(AssistantSessionsResponse.self, from: json)
        XCTAssertEqual(res.sessions.count, 2)

        let local = res.sessions[0]
        XCTAssertFalse(local.remoteOnly)
        XCTAssertNil(local.sourceBadge)
        XCTAssertTrue(local.isRunning)                 // latestRun.status == running
        XCTAssertEqual(local.adoptableRemoteId, "rem-1")
        XCTAssertEqual(local.updatedAt, "2026-07-28T12:00:00.000Z")

        let remote = res.sessions[1]
        XCTAssertTrue(remote.remoteOnly)
        XCTAssertEqual(remote.source, "tui")
        XCTAssertEqual(remote.sourceBadge, "TUI")
        XCTAssertFalse(remote.isRunning)
        XCTAssertEqual(remote.adoptableRemoteId, "abc")   // from remote_session_id
    }

    func testCreateResultRowDecodesWithoutRemoteOnly() throws {
        // POST /sessions returns a bare DB row: no remoteOnly / latestRun / source.
        let json = Data("""
        { "id": "s2", "title": "New Assistant Session", "remote_session_id": null,
          "remote_conversation_key": null, "status": "idle", "last_run_id": null,
          "last_response_id": null, "created_at": "a", "updated_at": "b", "archived_at": null }
        """.utf8)
        let session = try JSONDecoder.nexusCamel.decode(AssistantSession.self, from: json)
        XCTAssertFalse(session.remoteOnly)
        XCTAssertNil(session.latestRun)
        XCTAssertNil(session.source)
        XCTAssertNil(session.sourceBadge)
        XCTAssertFalse(session.isRunning)
    }

    func testSourceBadgeAndPrefixStripping() {
        XCTAssertEqual(AssistantSession(id: "remote:x", title: "T", remoteOnly: true, source: "cli").sourceBadge, "CLI")
        // Unknown/absent source on a remote row falls back to REMOTE.
        XCTAssertEqual(AssistantSession(id: "remote:x", title: "T", remoteOnly: true, source: "api_server").sourceBadge, "REMOTE")
        // With no explicit remote_session_id, strip the synthetic prefix off the id.
        let noRemoteId = AssistantSession(id: "remote:xyz", title: "T", remoteOnly: true)
        XCTAssertEqual(noRemoteId.adoptableRemoteId, "xyz")
    }

    // MARK: Session detail — optional Hermes message id

    func testDetailSynthesizesIdsForIdlessHermesRows() throws {
        // Hermes /messages rows may omit `id`; the tolerant AssistantMessage keeps
        // it optional and synthesizes an index id when projecting to PersistedMessage.
        let json = Data("""
        {
          "session": { "id": "s1", "title": "T", "status": "idle", "updated_at": "z" },
          "messages": [
            { "role": "user", "content": "hello", "timestamp": "t1" },
            { "role": "assistant", "content": "hi there", "thinking": null,
              "tool_calls": [ { "id": "c1", "name": "web_search", "args": { "query": "x" },
                                "status": "succeeded", "result": "ok", "is_error": false } ],
              "timestamp": "t2" }
          ],
          "latestRun": null
        }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        XCTAssertEqual(detail.session.title, "T")

        let persisted = detail.persistedMessages
        XCTAssertEqual(persisted.count, 2)
        XCTAssertEqual(persisted[0].id, "assistant-0")   // synthesized (no id on the wire)
        XCTAssertEqual(persisted[0].role, "user")
        XCTAssertEqual(persisted[1].id, "assistant-1")

        // Fold through the shared reducer path exactly like thread chat.
        var reducer = TranscriptReducer()
        reducer.loadPersisted(persisted)
        XCTAssertEqual(reducer.messages.count, 2)
        let assistant = reducer.messages[1]
        XCTAssertEqual(assistant.content, "hi there")
        XCTAssertEqual(assistant.toolCalls.first?.name, "web_search")
        XCTAssertEqual(assistant.toolCalls.first?.status, .completed)   // succeeded → completed
        // Nested arg key survives the plain decode.
        XCTAssertEqual(assistant.toolCalls.first?.args["query"]?.string, "x")
    }

    func testDetailToleratesNumericMessageId() throws {
        // The local-store fallback surfaces the integer PK as a JSON *number*
        // (e.g. `"id": 31`). Decoding that into `String?` used to throw and reach
        // the user as "The server sent an unexpected response". It must now decode.
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" },
          "messages": [
            { "id": 31, "role": "user", "content": "Hey Baker. Just testing" },
            { "id": 32, "role": "assistant", "content": "hi" }
          ],
          "latestRun": null }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        let persisted = detail.persistedMessages
        XCTAssertEqual(persisted.map(\.id), ["31", "32"])   // numeric ids stringified
        XCTAssertEqual(persisted[0].content, "Hey Baker. Just testing")

        // Folds through the shared reducer unchanged.
        var reducer = TranscriptReducer()
        reducer.loadPersisted(persisted)
        XCTAssertEqual(reducer.messages.count, 2)
    }

    func testMessageIdVariants() throws {
        func decodeId(_ body: String) throws -> String? {
            try JSONDecoder.nexusCamel.decode(AssistantMessage.self, from: Data(body.utf8)).id
        }
        XCTAssertEqual(try decodeId(#"{"id": 31, "role":"user"}"#), "31")        // number
        XCTAssertEqual(try decodeId(#"{"id": "m-1", "role":"user"}"#), "m-1")    // string
        XCTAssertNil(try decodeId(#"{"role":"user"}"#))                          // absent
        XCTAssertNil(try decodeId(#"{"id": null, "role":"user"}"#))             // null
    }

    func testDetailKeepsExplicitMessageId() throws {
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" },
          "messages": [ { "id": "msg-real", "role": "user", "content": "hi" } ] }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        XCTAssertEqual(detail.persistedMessages.first?.id, "msg-real")
        XCTAssertNil(detail.latestRun)          // absent latestRun tolerated
    }

    // MARK: Stream replay

    func testAssistantStreamFoldsTitleTextAndTool() throws {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "stream_assistant", withExtension: "ndjson", subdirectory: "Fixtures"))
        let text = try String(contentsOf: url, encoding: .utf8)
        var reducer = TranscriptReducer()
        reducer.startTurn(prompt: "What's the weather?")
        for line in text.split(separator: "\n") {
            if let value = JSONValue.parse(Data(line.utf8)) { reducer.apply(value) }
        }

        // session_title captured (the VM consumes pendingTitle to rename live).
        XCTAssertEqual(reducer.pendingTitle, "Weather check")
        XCTAssertNil(reducer.streaming, "run_end finalizes the streaming bubble")
        XCTAssertEqual(reducer.status, .idle)

        let assistant = try XCTUnwrap(reducer.messages.last)
        XCTAssertEqual(assistant.role, .assistant)
        // Paragraph break inserted between pre-tool and post-tool prose.
        XCTAssertEqual(assistant.content, "Let me check the weather.\n\nIt's sunny, 24C.")
        XCTAssertEqual(assistant.provider, "assistant")
        XCTAssertEqual(assistant.model, "hermes-agent")
        XCTAssertEqual(assistant.toolCalls.count, 1)
        let tool = assistant.toolCalls[0]
        XCTAssertEqual(tool.name, "web_search")
        XCTAssertEqual(tool.status, .completed)
        XCTAssertEqual(tool.result, "Sunny, 24C")
        XCTAssertEqual(tool.args["query"]?.string, "weather today")
    }
}
