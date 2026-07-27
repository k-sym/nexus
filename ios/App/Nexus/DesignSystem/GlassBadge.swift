import SwiftUI

/// Liquid Glass badge primitives for "unread"/pending indicators.
///
/// On iOS 26 these use the real `.glassEffect` material so they pick up the
/// system's translucency, depth and specular highlights. On earlier OSes they
/// fall back to a tinted `.ultraThinMaterial` capsule that reads the same.
///
/// Two shapes:
///   * `GlassBadge(count:)`  — a count pill (e.g. Approvals tab).
///   * `GlassUnreadDot()`    — a small dot for row-level "new message" hints.

// MARK: - Count pill

struct GlassBadge: View {
    let count: Int
    /// Accent the glass is tinted with. Defaults to the app accent.
    var tint: Color = Theme.accent

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, count > 9 ? 7 : 6)
                .padding(.vertical, 2)
                .frame(minWidth: 20, minHeight: 20)
                .glassBadgeBackground(tint: tint, shape: Capsule())
                .accessibilityLabel("\(count) unread")
        }
    }
}

// MARK: - Unread dot

struct GlassUnreadDot: View {
    var tint: Color = Theme.accent
    var diameter: CGFloat = 10

    var body: some View {
        Circle()
            .fill(.clear)
            .frame(width: diameter, height: diameter)
            .glassBadgeBackground(tint: tint, shape: Circle())
            .overlay(
                Circle().strokeBorder(.white.opacity(0.25), lineWidth: 0.5)
            )
            .accessibilityLabel("Unread")
    }
}

// MARK: - Glass background modifier (with graceful fallback)

private extension View {
    @ViewBuilder
    func glassBadgeBackground(tint: Color, shape: some Shape) -> some View {
        if #available(iOS 26.0, *) {
            // Real Liquid Glass: a tinted glass capsule/circle. No opaque fill
            // underneath — the tint rides on the glass so it stays translucent
            // and picks up the system's depth/specular highlights.
            self.glassEffect(.regular.tint(tint).interactive(), in: shape)
        } else {
            // Fallback: tinted translucent material reads as "glassy".
            self.background(
                shape.fill(tint.opacity(0.9))
                    .background(.ultraThinMaterial, in: shape)
            )
            .overlay(shape.stroke(Color.white.opacity(0.18), lineWidth: 0.5))
        }
    }
}

#Preview {
    ZStack {
        LinearGradient(colors: [.black, .blue.opacity(0.4)], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
        VStack(spacing: 24) {
            GlassBadge(count: 3)
            GlassBadge(count: 128)
            GlassUnreadDot()
        }
    }
}
