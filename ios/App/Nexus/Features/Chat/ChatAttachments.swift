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
/// foreground reconcile, a 5s background-run sync poll, and reopening the session
/// (the singleton outlives the view). Process-lifetime only; a cold launch falls
/// back to the server's text-only transcript.
@MainActor
final class AssistantAttachmentStore {
    static let shared = AssistantAttachmentStore()
    private var byScope: [String: [Int: [RenderedAttachment]]] = [:]

    func record(scope: String, ordinal: Int, _ attachments: [RenderedAttachment]) {
        guard !attachments.isEmpty else { return }
        byScope[scope, default: [:]][ordinal] = attachments
    }

    /// The whole ordinal→attachments map for a session, snapshotted so a
    /// synchronous provider closure can read it without an actor hop.
    func snapshot(scope: String) -> [Int: [RenderedAttachment]] {
        byScope[scope] ?? [:]
    }

    /// Drop a session's cache (on hard delete).
    func purge(scope: String) { byScope[scope] = nil }
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
