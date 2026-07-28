import UIKit
import NexusCore

/// A picked attachment held in the composer until send: the wire form
/// (`AssistantAttachment`, base64) plus a decoded thumbnail for the chip. Bridges
/// to `RenderedAttachment` so the optimistic user bubble can show the same image.
struct AttachmentDraft: Identifiable {
    let id: UUID
    let image: UIImage
    let attachment: AssistantAttachment

    /// The in-bubble render form (base64 kept; the view decodes it).
    var rendered: RenderedAttachment {
        RenderedAttachment(id: id.uuidString, name: attachment.name, mimeType: attachment.mimeType, base64: attachment.data)
    }
}

/// Turns a picked photo into a send-ready image attachment. Photos come in as
/// HEIC/PNG/huge JPEGs; the backend's vision path only accepts png/jpeg/gif/webp,
/// so normalize everything to a downscaled JPEG — smaller payloads and a MIME the
/// server allows.
enum AttachmentEncoder {
    static let maxDimension: CGFloat = 1568   // a common vision-model long-edge cap
    static let jpegQuality: CGFloat = 0.8

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
}
