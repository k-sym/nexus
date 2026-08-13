import XCTest
@testable import NexusCore

/// #75 — assistant model picker + context meter: the detail payload's seeds,
/// the stream request's modelKey, and the reducer's rehydrate seeding.
final class AssistantModelPickerTests: XCTestCase {

    func testDetailDecodesModelAndContextSeeds() throws {
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" },
          "messages": [],
          "latestRun": null,
          "lastModelKey": "partner/opus",
          "contextUsage": { "tokens": 50000, "contextWindow": 200000, "percent": 25 } }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        XCTAssertEqual(detail.lastModelKey, "partner/opus")
        let usage = try XCTUnwrap(ContextUsage(detail.contextUsage))
        XCTAssertEqual(usage.tokens, 50000)
        XCTAssertEqual(usage.contextWindow, 200000)
        XCTAssertEqual(usage.percent, 25)
    }

    func testDetailToleratesAbsentSeeds() throws {
        // Pre-#75 backend / plain-Hermes rows: both seeds absent.
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" }, "messages": [] }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        XCTAssertNil(detail.lastModelKey)
        XCTAssertNil(detail.contextUsage)
        XCTAssertNil(ContextUsage(detail.contextUsage))
    }

    func testStreamRequestEncodesModelKeyAndOmitsNil() throws {
        let with = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(AssistantStreamRequest(content: "hi", modelKey: "partner/haiku"))
        ) as? [String: Any]
        XCTAssertEqual(with?["modelKey"] as? String, "partner/haiku")

        let without = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(AssistantStreamRequest(content: "hi"))
        ) as? [String: Any]
        XCTAssertNil(without?["modelKey"])   // omitted → session default upstream
    }

    func testReducerSeedsContextUsageAndIgnoresNil() throws {
        var reducer = TranscriptReducer()
        XCTAssertNil(reducer.contextUsage)
        let seed = try XCTUnwrap(ContextUsage(JSONValue.object([
            "tokens": .number(1200), "contextWindow": .number(200000), "percent": .number(1),
        ])))
        reducer.seedContextUsage(seed)
        XCTAssertEqual(reducer.contextUsage?.tokens, 1200)
        // A seed-less rehydrate (nil) must not blank a populated meter.
        reducer.seedContextUsage(nil)
        XCTAssertEqual(reducer.contextUsage?.tokens, 1200)
        // loadPersisted (the 5s sync poll path) keeps the meter too.
        reducer.loadPersisted([])
        XCTAssertEqual(reducer.contextUsage?.contextWindow, 200000)
    }

    func testAssistantEndpointAdvertisesModelPicker() {
        let endpoint = AssistantChatEndpoint(api: APIClient(), sessionId: "s1")
        XCTAssertTrue(endpoint.supportsModelPicker)
    }
}
