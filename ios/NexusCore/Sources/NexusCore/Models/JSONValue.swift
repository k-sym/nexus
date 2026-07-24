import Foundation

/// A dynamically-typed JSON value. Used for stream events and for arbitrary
/// fields the backend stringifies loosely (tool `args`, tool `details`).
///
/// IMPORTANT: always decode this with a *plain* `JSONDecoder` (default key
/// strategy). Decoding it through `.convertFromSnakeCase` would rewrite nested
/// keys like `file_path` → `filePath` and corrupt the data.
public enum JSONValue: Decodable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unsupported JSON value")
        }
    }

    /// Parse a single NDJSON line (or any JSON `Data`) into a value.
    public static func parse(_ data: Data) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    // MARK: Accessors

    public subscript(_ key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var double: Double? { if case .number(let n) = self { return n }; return nil }
    public var int: Int? { if case .number(let n) = self { return Int(n) }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }

    /// Join the `text` fields of a `content` array (Pi tool/message blocks) into
    /// one string. Empty when this isn't such an array.
    public var joinedContentText: String {
        guard case .array(let items) = self else { return "" }
        return items.compactMap { $0["text"]?.string }.joined()
    }
}
