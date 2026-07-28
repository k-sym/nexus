import XCTest
@testable import NexusCore

/// Covers the M6 Phase B attachments/vision layer: the outbound attachment
/// encoding, its inclusion in the stream/run request body, the endpoint
/// capability flag, and the reducer carrying attachments on the user's turn.
final class AssistantAttachmentTests: XCTestCase {

    private func encodeToObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: Attachment encoding

    func testImageAttachmentEncodesTypeDataMimeAndOmitsNilFields() throws {
        let att = AssistantAttachment(type: .image, data: "YmFzZTY0", mimeType: "image/jpeg")
        let obj = try encodeToObject(att)
        XCTAssertEqual(obj["type"] as? String, "image")
        XCTAssertEqual(obj["data"] as? String, "YmFzZTY0")
        XCTAssertEqual(obj["mimeType"] as? String, "image/jpeg")
        XCTAssertNil(obj["name"], "nil name omitted")
        XCTAssertNil(obj["size"], "nil size omitted")
        XCTAssertTrue(att.isImage)
    }

    func testAttachmentEncodesNameAndSizeWhenPresent() throws {
        let att = AssistantAttachment(type: .file, data: "eA==", mimeType: "application/pdf", name: "spec.pdf", size: 1234)
        let obj = try encodeToObject(att)
        XCTAssertEqual(obj["type"] as? String, "file")
        XCTAssertEqual(obj["name"] as? String, "spec.pdf")
        XCTAssertEqual(obj["size"] as? Int, 1234)
        XCTAssertFalse(att.isImage)
    }

    // MARK: Request body

    func testStreamRequestOmitsAttachmentsWhenEmpty() throws {
        let obj = try encodeToObject(AssistantStreamRequest(content: "hi"))
        XCTAssertEqual(obj["content"] as? String, "hi")
        XCTAssertNil(obj["attachments"], "text-only turns stay {content}")
    }

    func testStreamRequestIncludesAttachmentsWhenPresent() throws {
        let att = AssistantAttachment(type: .image, data: "ZA==", mimeType: "image/png", name: "p.png", size: 3)
        let obj = try encodeToObject(AssistantStreamRequest(content: "look", attachments: [att]))
        let arr = try XCTUnwrap(obj["attachments"] as? [[String: Any]])
        XCTAssertEqual(arr.count, 1)
        XCTAssertEqual(arr[0]["mimeType"] as? String, "image/png")
    }

    // MARK: File MIME mapping

    func testFileMimeMappingCoversAllowedExtensionsCaseInsensitively() {
        XCTAssertEqual(AssistantAttachment.fileMimeType(forExtension: "pdf"), "application/pdf")
        XCTAssertEqual(AssistantAttachment.fileMimeType(forExtension: "CSV"), "text/csv")
        XCTAssertEqual(AssistantAttachment.fileMimeType(forExtension: "Md"), "text/markdown")
        XCTAssertEqual(
            AssistantAttachment.fileMimeType(forExtension: "docx"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        XCTAssertEqual(
            AssistantAttachment.fileMimeType(forExtension: "xlsx"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    }

    func testFileMimeMappingRejectsUnsupportedExtension() {
        XCTAssertNil(AssistantAttachment.fileMimeType(forExtension: "heic"))
        XCTAssertNil(AssistantAttachment.fileMimeType(forExtension: "exe"))
        XCTAssertNil(AssistantAttachment.fileMimeType(forExtension: ""))
    }

    // MARK: Endpoint capability

    func testAssistantEndpointSupportsAttachmentsThreadDoesNot() {
        let assistant: ChatEndpoint = AssistantChatEndpoint(api: APIClient(), sessionId: "s1")
        let thread: ChatEndpoint = ThreadChatEndpoint(api: APIClient(), threadId: "t1")
        XCTAssertTrue(assistant.supportsAttachments)
        XCTAssertFalse(thread.supportsAttachments)
    }

    // MARK: Preserve attachments across a reload (ordinal-keyed)

    func testLoadPersistedReattachesByUserOrdinal() throws {
        // The server transcript is text-only; the provider restores thumbnails by
        // each user row's ordinal — including a file whose content the backend
        // augmented with a path suffix (so content-matching would miss it).
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" },
          "messages": [
            { "role": "assistant", "content": "hi" },
            { "role": "user", "content": "look at this" },
            { "role": "assistant", "content": "nice" },
            { "role": "user", "content": "summarize\\n\\nAttached files:\\n- notes.txt: /uploads/notes.txt" }
          ] }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)

        let img = RenderedAttachment(id: "a0", name: "p.jpg", mimeType: "image/jpeg", base64: "Zm9v")
        let file = RenderedAttachment(id: "a1", name: "notes.txt", mimeType: "text/plain", base64: "")
        let byOrdinal: [Int: [RenderedAttachment]] = [0: [img], 1: [file]]

        var reducer = TranscriptReducer()
        reducer.loadPersisted(detail.persistedMessages) { byOrdinal[$0] ?? [] }

        let users = reducer.messages.filter { $0.role == .user }
        XCTAssertEqual(users.count, 2)
        XCTAssertEqual(users[0].attachments.map(\.id), ["a0"])   // ordinal 0 → image
        XCTAssertEqual(users[1].attachments.map(\.id), ["a1"])   // ordinal 1 → file (augmented content)
        XCTAssertFalse(users[1].attachments[0].isImage)
    }

    func testUserMessageCountTracksSentOrdinals() {
        var reducer = TranscriptReducer()
        XCTAssertEqual(reducer.userMessageCount, 0)               // first send → ordinal 0
        reducer.startTurn(prompt: "one")
        XCTAssertEqual(reducer.userMessageCount, 1)               // next send → ordinal 1
        reducer.appendUserMessage("two")
        XCTAssertEqual(reducer.userMessageCount, 2)
    }

    // MARK: Reducer carries attachments on the user turn

    func testStartTurnAttachesToUserMessageAndReloadClearsThem() {
        let att = RenderedAttachment(id: "a1", name: "p.jpg", mimeType: "image/jpeg", base64: "Zm9v")
        var reducer = TranscriptReducer()
        reducer.startTurn(prompt: "what is this?", attachments: [att])

        let user = reducer.messages[0]
        XCTAssertEqual(user.role, .user)
        XCTAssertEqual(user.attachments.map(\.id), ["a1"])
        XCTAssertTrue(user.attachments[0].isImage)

        // A persisted reload (server transcript has no attachments) clears them.
        reducer.loadPersisted([])
        XCTAssertTrue(reducer.messages.isEmpty)
    }

    func testAppendUserMessageCarriesAttachments() {
        let att = RenderedAttachment(id: "a2", name: nil, mimeType: "image/png", base64: "YmFy")
        var reducer = TranscriptReducer()
        reducer.appendUserMessage("bg with file", attachments: [att])
        XCTAssertEqual(reducer.messages.count, 1)
        XCTAssertEqual(reducer.messages[0].attachments.first?.id, "a2")
        XCTAssertNil(reducer.streaming, "background append opens no streaming bubble")
    }
}
