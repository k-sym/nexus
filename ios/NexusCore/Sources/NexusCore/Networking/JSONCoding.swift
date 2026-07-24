import Foundation

public extension JSONDecoder {
    /// Decoder for REST resource payloads, whose keys are snake_case
    /// (`project_id`, `created_at`, `repo_path`). Never use this for stream
    /// events — those are camelCase and `.convertFromSnakeCase` would corrupt
    /// keys like `toolCallId`.
    static var nexusREST: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    /// Plain decoder (default key strategy) for camelCase payloads such as the
    /// 409 busy body and stream events.
    static var nexusCamel: JSONDecoder { JSONDecoder() }
}
