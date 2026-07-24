import SwiftUI

/// Design tokens. Kept intentionally small for M0; expands as screens land.
enum Theme {
    static let accent = Color.accentColor
    static let cornerRadius: CGFloat = 12
}

extension Color {
    /// Parse a `#rrggbb` (or `rrggbb`) hex string. Returns nil on bad input.
    init?(hex: String?) {
        guard var hex else { return nil }
        hex = hex.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255)
    }
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
