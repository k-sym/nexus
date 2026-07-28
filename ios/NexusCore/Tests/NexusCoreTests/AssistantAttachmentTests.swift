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

    // MARK: Endpoint capability

    func testAssistantEndpointSupportsAttachmentsThreadDoesNot() {
        let assistant: ChatEndpoint = AssistantChatEndpoint(api: APIClient(), sessionId: "s1")
        let thread: ChatEndpoint = ThreadChatEndpoint(api: APIClient(), threadId: "t1")
        XCTAssertTrue(assistant.supportsAttachments)
        XCTAssertFalse(thread.supportsAttachments)
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
