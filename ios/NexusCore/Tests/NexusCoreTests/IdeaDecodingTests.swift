import XCTest
@testable import NexusCore

final class IdeaDecodingTests: XCTestCase {

    /// A full `GET /api/ideas?all=1` payload: snake_case row keys, both
    /// graduation shapes (camelCase inner keys), and a state this build has
    /// never heard of.
    func testIdeasListDecode() throws {
        let json = Data("""
        [
          {"id":"i1","title":"Glasses HUD idea","seed":"One-liner from the shower.","state":"parked","tags":[],
           "target_repo":null,"session_id":null,"graduated_to":null,"source":"idea_watcher",
           "created_at":"2026-08-17T09:00:00.000Z","updated_at":"2026-08-17T09:00:00.000Z"},
          {"id":"i2","title":"Ripening","seed":"","state":"researching","tags":["ios","infra"],
           "target_repo":"k-sym/nexus","session_id":"sess-2","graduated_to":null,"source":"idea_watcher",
           "created_at":"a","updated_at":"b"},
          {"id":"i3","title":"Became a project","seed":"","state":"graduated","tags":[],
           "target_repo":null,"session_id":"sess-3",
           "graduated_to":{"kind":"project","projectId":"proj_glasses","taskId":"t42"},
           "source":"braindump","created_at":"a","updated_at":"b"},
          {"id":"i4","title":"Filed as issues","seed":"","state":"graduated","tags":[],
           "target_repo":"k-sym/nexus","session_id":"sess-4",
           "graduated_to":{"kind":"issues","urls":["https://github.com/k-sym/nexus/issues/360","https://github.com/k-sym/nexus/issues/361"]},
           "source":"idea_watcher","created_at":"a","updated_at":"b"},
          {"id":"i5","title":"From the future","seed":"","state":"fermenting","tags":[],
           "target_repo":null,"session_id":null,"graduated_to":null,"source":"idea_watcher",
           "created_at":"a","updated_at":"b"}
        ]
        """.utf8)
        let ideas = try JSONDecoder.nexusREST.decode([Idea].self, from: json)
        XCTAssertEqual(ideas.count, 5)

        let parked = ideas[0]
        XCTAssertEqual(parked.state, .parked)
        XCTAssertEqual(parked.seed, "One-liner from the shower.")
        XCTAssertNil(parked.targetRepo)
        XCTAssertNil(parked.sessionId)
        XCTAssertNil(parked.graduatedTo)

        let researching = ideas[1]
        XCTAssertEqual(researching.state, .researching)
        XCTAssertEqual(researching.tags, ["ios", "infra"])
        XCTAssertEqual(researching.targetRepo, "k-sym/nexus")
        XCTAssertEqual(researching.sessionId, "sess-2")

        // Project graduation, camelCase inner keys.
        guard case .project(let projectId, let taskId)? = ideas[2].graduatedTo else {
            return XCTFail("expected a project graduation")
        }
        XCTAssertEqual(projectId, "proj_glasses")
        XCTAssertEqual(taskId, "t42")
        XCTAssertEqual(ideas[2].source, "braindump")

        // Issues graduation.
        guard case .issues(let urls)? = ideas[3].graduatedTo else {
            return XCTFail("expected an issues graduation")
        }
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls.first, "https://github.com/k-sym/nexus/issues/360")
        XCTAssertEqual(ideas[3].graduatedTo?.issueURLs, urls)

        // Unknown state must not fail the row (RoutineHealth pattern).
        XCTAssertEqual(ideas[4].state, .unknown)
    }

    /// A graduation kind this build doesn't know decodes as `.unknown`, not a throw.
    func testUnknownGraduationKindDecode() throws {
        let json = Data("""
        {"id":"i9","title":"x","seed":"","state":"graduated","tags":[],"target_repo":null,
         "session_id":null,"graduated_to":{"kind":"gist","urls":[]},"source":"idea_watcher",
         "created_at":"a","updated_at":"b"}
        """.utf8)
        let idea = try JSONDecoder.nexusREST.decode(Idea.self, from: json)
        guard case .unknown(let kind)? = idea.graduatedTo else {
            return XCTFail("expected an unknown graduation")
        }
        XCTAssertEqual(kind, "gist")
        XCTAssertEqual(idea.graduatedTo?.issueURLs, [])
    }

    /// `POST /api/ideas/:id/session` is a route-built object: camelCase key,
    /// which `.nexusREST`'s convertFromSnakeCase passes through unchanged.
    func testIdeaSessionResponseDecode() throws {
        let json = Data(#"{"sessionId":"3f6a2b"}"#.utf8)
        let res = try JSONDecoder.nexusREST.decode(IdeaSessionResponse.self, from: json)
        XCTAssertEqual(res.sessionId, "3f6a2b")
    }

    func testCreateIdeaRequestOmitsNilSeed() throws {
        let data = try JSONEncoder().encode(CreateIdeaRequest(title: "Park me"))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["title"]?.string, "Park me")
        XCTAssertNil(json["seed"])
    }

    /// PATCH bodies must omit unset fields (COALESCE semantics server-side)
    /// and spell the one snake_case key, `target_repo`, correctly.
    func testUpdateIdeaRequestEncoding() throws {
        let data = try JSONEncoder().encode(
            UpdateIdeaRequest(state: .discarded, targetRepo: "k-sym/nexus"))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["state"]?.string, "discarded")
        XCTAssertEqual(json["target_repo"]?.string, "k-sym/nexus")
        XCTAssertNil(json["title"])
        XCTAssertNil(json["seed"])
        XCTAssertNil(json["tags"])
        XCTAssertNil(json["targetRepo"])
    }
}
