import SwiftUI

/// Design tokens. Kept intentionally small for M0; expands as screens land.
enum Theme {
    static let accent = Color.accentColor
    static let cornerRadius: CGFloat = 12
}

/// A compact rounded label used for counts and status. A DesignSystem primitive
/// reused across screens.
struct StatusPill: View {
    let text: String
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(text)
        }
        .font(.subheadline.weight(.medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
    }
}
