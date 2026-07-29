import SwiftUI
import UniformTypeIdentifiers
import NexusCore

/// A picked attachment held in the composer until send: the wire form
/// (`AssistantAttachment`, base64) plus, for images, a decoded thumbnail. Files
/// have no thumbnail and render as a labeled card instead. Bridges to
/// `RenderedAttachment` so the optimistic user bubble can show the same content.
struct AttachmentDraft: Identifiable {
    let id: UUID
    let image: UIImage?     // nil for non-image files
    let attachment: AssistantAttachment

    /// The in-bubble render form. Images keep their base64 for the thumbnail;
    /// files render as a name+glyph card, so we drop the (potentially large) file
    /// bytes to keep the preserve-across-reload cache lean.
    var rendered: RenderedAttachment {
        RenderedAttachment(
            id: id.uuidString, name: attachment.name, mimeType: attachment.mimeType,
            base64: attachment.isImage ? attachment.data : "")
    }
}

/// In-memory cache of sent-attachment thumbnails, keyed by session + the user
/// message's 0-based ordinal. The server transcript is text-only, so on every
/// rehydrate `ChatViewModel` re-attaches from here — thumbnails then survive a
/// foreground reconcile, a 5s background-run sync poll, reopening the session
/// (the singleton outlives the view), AND a cold app relaunch — the cache mirrors
/// to a JSON file in Caches, reloaded on init. A byte budget evicts the oldest
/// sets (LRU by insertion) so it can't grow without bound; Caches is also
/// OS-reclaimable, which is fine for best-effort thumbnails.
@MainActor
final class AssistantAttachmentStore {
    static let shared = AssistantAttachmentStore()

    private struct Key: Hashable, Codable { let scope: String; let ordinal: Int }
    private struct Entry: Codable { let key: Key; let attachments: [RenderedAttachment] }

    private var byScope: [String: [Int: [RenderedAttachment]]] = [:]
    private var order: [Key] = []                 // insertion order, oldest first
    private let maxBytes = 8 * 1024 * 1024         // ~8 MB of base64 thumbnails

    private static let fileURL: URL? =
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("assistant-attachment-cache.json")

    init() { load() }

    func record(scope: String, ordinal: Int, _ attachments: [RenderedAttachment]) {
        guard !attachments.isEmpty else { return }
        if byScope[scope]?[ordinal] == nil { order.append(Key(scope: scope, ordinal: ordinal)) }
        byScope[scope, default: [:]][ordinal] = attachments
        evictIfNeeded()
        save()
    }

    /// The whole ordinal→attachments map for a session, snapshotted so a
    /// synchronous provider closure can read it without an actor hop.
    func snapshot(scope: String) -> [Int: [RenderedAttachment]] {
        byScope[scope] ?? [:]
    }

    /// Drop a session's cache (on hard delete).
    func purge(scope: String) {
        guard byScope[scope] != nil else { return }
        byScope[scope] = nil
        order.removeAll { $0.scope == scope }
        save()
    }

    // MARK: Budget + disk

    /// Evict the oldest sets until under the byte budget.
    private func evictIfNeeded() {
        var total = byScope.values.reduce(0) { $0 + $1.values.reduce(0) { $0 + $1.reduce(0) { $0 + $1.base64.count } } }
        var dropped = 0
        while total > maxBytes, dropped < order.count {
            let key = order[dropped]; dropped += 1
            if let set = byScope[key.scope]?[key.ordinal] {
                total -= set.reduce(0) { $0 + $1.base64.count }
                byScope[key.scope]?[key.ordinal] = nil
                if byScope[key.scope]?.isEmpty == true { byScope[key.scope] = nil }
            }
        }
        if dropped > 0 { order.removeFirst(dropped) }
    }

    private func load() {
        guard let url = Self.fileURL, let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return }
        for entry in entries {
            byScope[entry.key.scope, default: [:]][entry.key.ordinal] = entry.attachments
            order.append(entry.key)
        }
    }

    /// Snapshot in insertion order (so a reload restores LRU ordering) and write
    /// off the main actor — thumbnails aren't worth blocking the UI for.
    /// Snapshot in insertion order (so a reload restores LRU ordering) and write
    /// off the main actor — thumbnails aren't worth blocking the UI for.
    private func save() {
        guard let url = Self.fileURL else { return }
        let entries: [Entry] = order.compactMap { key in
            guard let set = byScope[key.scope]?[key.ordinal] else { return nil }
            return Entry(key: key, attachments: set)
        }
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(entries) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}

/// Turns picked photos and files into send-ready attachments.
///
/// Photos come in as HEIC/PNG/huge JPEGs; the backend's vision path only accepts
/// png/jpeg/gif/webp, so normalize everything to a downscaled JPEG. Files are
/// read as-is and tagged with a backend-allowed MIME derived from their extension
/// (the file picker is already restricted to `allowedFileTypes`).
enum AttachmentEncoder {
    static let maxDimension: CGFloat = 1568   // a common vision-model long-edge cap
    static let jpegQuality: CGFloat = 0.8

    // MARK: Images

    static func imageDraft(from image: UIImage, index: Int) -> AttachmentDraft? {
        let scaled = downscaled(image)
        guard let data = scaled.jpegData(compressionQuality: jpegQuality) else { return nil }
        let attachment = AssistantAttachment(
            type: .image,
            data: data.base64EncodedString(),
            mimeType: "image/jpeg",
            name: "photo-\(index + 1).jpg",
            size: data.count)
        return AttachmentDraft(id: UUID(), image: scaled, attachment: attachment)
    }

    private static func downscaled(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension, longest > 0 else { return image }
        let scale = maxDimension / longest
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1   // target is already in pixels; don't multiply by screen scale
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    // MARK: Files

    /// UTTypes the file importer offers — exactly the extensions we can tag with a
    /// backend-allowed MIME (`AssistantAttachment.fileMimeTypesByExtension`).
    static let allowedFileTypes: [UTType] = {
        var types: [UTType] = [.pdf, .plainText, .commaSeparatedText]
        for ext in AssistantAttachment.fileMimeTypesByExtension.keys {
            if let t = UTType(filenameExtension: ext) { types.append(t) }
        }
        return types
    }()

    /// Read a picked file URL (security-scoped) and encode it. Returns nil if the
    /// extension isn't supported or the bytes can't be read.
    static func fileDraft(from url: URL) -> AttachmentDraft? {
        guard let mime = AssistantAttachment.fileMimeType(forExtension: url.pathExtension) else { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        let attachment = AssistantAttachment(
            type: .file,
            data: data.base64EncodedString(),
            mimeType: mime,
            name: url.lastPathComponent,
            size: data.count)
        return AttachmentDraft(id: UUID(), image: nil, attachment: attachment)
    }
}

/// A compact card for a non-image attachment: a type glyph + filename, used both
/// in the composer tray and on the sent bubble.
struct FileAttachmentCard: View {
    let name: String
    let mimeType: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: Self.symbol(for: mimeType))
                .foregroundStyle(.secondary)
            Text(name)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    static func symbol(for mimeType: String) -> String {
        switch mimeType {
        case "application/pdf": return "doc.richtext"
        case "text/csv", "application/csv",
             "application/vnd.ms-excel",
             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "tablecells"
        case "application/msword",
             "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "doc.text"
        default: return "doc.plaintext"
        }
    }
}
