import SwiftUI

/// Stand-in for sections whose real UI arrives in a later milestone. Keeps the
/// navigation shell complete and honest about what's not built yet.
struct PlaceholderView: View {
    let title: String
    let systemImage: String
    var note: String = "Coming in a later milestone."

    var body: some View {
        ContentUnavailableView(title, systemImage: systemImage, description: Text(note))
            .navigationTitle(title)
    }
}
