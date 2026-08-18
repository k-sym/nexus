import SwiftUI
import NexusCore

/// Native structured Markdown for assistant output. User-authored messages stay
/// on the plain `Text` path in `MessageBubble`.
struct MarkdownText: View {
    private let document: MarkdownDocument

    init(text: String) {
        document = MarkdownDocument(parsing: text)
    }

    var body: some View {
        MarkdownBlocksView(blocks: document.blocks)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case .paragraph(let text):
            InlineMarkdownText(text: text)
                .font(.body)
        case .heading(let level, let text):
            InlineMarkdownText(text: text)
                .font(headingFont(level))
                .accessibilityAddTraits(.isHeader)
                .padding(.top, level <= 2 ? 4 : 0)
        case .unorderedList(let items):
            MarkdownListView(items: items, start: nil)
        case .orderedList(let start, let items):
            MarkdownListView(items: items, start: start)
        case .blockquote(let blocks):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Theme.accent.opacity(0.65))
                    .frame(width: 3)
                MarkdownBlocksView(blocks: blocks)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .codeBlock(let language, let code):
            MarkdownCodeBlock(language: language, code: code)
        case .table(let table):
            AdaptiveMarkdownTable(table: table)
        case .thematicBreak:
            Divider()
        case .rawText(let text):
            Text(text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2.bold()
        case 2: return .title3.bold()
        case 3: return .headline.bold()
        default: return .subheadline.bold()
        }
    }
}

private struct InlineMarkdownText: View {
    let text: String

    var body: some View {
        Text(attributed)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        guard var value = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return AttributedString(text)
        }

        // Match the desktop renderer's link boundary. `Text` can open links,
        // but arbitrary/custom URL schemes should remain inert prose.
        let unsafeRanges = value.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link, !Self.isAllowed(link) else { return nil }
            return run.range
        }
        for range in unsafeRanges { value[range].link = nil }
        return value
    }

    private static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http" || scheme == "mailto"
    }
}

private struct MarkdownListView: View {
    let items: [MarkdownListItem]
    let start: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 8) {
                    marker(for: item, index: index)
                        .frame(width: 22, alignment: .trailing)
                        .padding(.top, 2)
                    MarkdownBlocksView(blocks: item.blocks)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownListItem, index: Int) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? Theme.accent : Color.secondary)
                .accessibilityLabel(checked ? "Completed" : "Not completed")
        } else if let start {
            Text("\(start + index).")
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        } else {
            Circle()
                .fill(.secondary)
                .frame(width: 5, height: 5)
                .padding(.top, 7)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language, !language.isEmpty {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Code language: \(language)")
            }
            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

/// Tables reflow into labeled records in compact layouts or accessibility text
/// sizes. Regular-width layouts retain a conventional grid and scroll only if
/// the content genuinely needs more horizontal room.
private struct AdaptiveMarkdownTable: View {
    let table: MarkdownTable
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if horizontalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize {
            cardTable
        } else {
            gridTable
        }
    }

    private var cardTable: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, value in
                        VStack(alignment: .leading, spacing: 2) {
                            InlineMarkdownText(text: header(for: column))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            InlineMarkdownText(text: value)
                                .font(.body)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.primary.opacity(0.12), lineWidth: 1)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table with \(table.rows.count) rows")
    }

    private var gridTable: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.headers.enumerated()), id: \.offset) { column, header in
                        gridCell(header, column: column, isHeader: true)
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, value in
                            gridCell(value, column: column, isHeader: false)
                        }
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.primary.opacity(0.16), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table with \(table.rows.count) rows and \(table.headers.count) columns")
    }

    private func gridCell(_ text: String, column: Int, isHeader: Bool) -> some View {
        InlineMarkdownText(text: text)
            .font(isHeader ? .subheadline.weight(.semibold) : .body)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(minWidth: 110, maxWidth: 240, alignment: alignment(for: column))
            .background(isHeader ? Color.primary.opacity(0.075) : Color.clear)
            .overlay(alignment: .trailing) { Divider() }
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityAddTraits(isHeader ? .isHeader : [])
    }

    private func header(for column: Int) -> String {
        guard table.headers.indices.contains(column), !table.headers[column].isEmpty else {
            return "Column \(column + 1)"
        }
        return table.headers[column]
    }

    private func alignment(for column: Int) -> Alignment {
        guard table.alignments.indices.contains(column) else { return .leading }
        switch table.alignments[column] {
        case .center?: return .center
        case .right?: return .trailing
        case .left?, nil: return .leading
        }
    }
}
