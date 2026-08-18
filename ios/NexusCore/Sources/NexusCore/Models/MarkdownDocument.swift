import Foundation
import Markdown

/// UI-free, safe projection of GitHub-flavoured Markdown into the block types
/// Nexus renders natively. Inline source stays as Markdown so each client can
/// apply its platform typography without exposing swift-markdown's node tree.
public struct MarkdownDocument: Equatable, Sendable {
    public let blocks: [MarkdownBlock]

    public init(parsing source: String) {
        let document = Markdown.Document(parsing: source, options: [.disableSmartOpts])
        blocks = document.children.flatMap(Self.project)
    }

    private static func project(_ markup: Markup) -> [MarkdownBlock] {
        switch markup {
        case let paragraph as Paragraph:
            return [.paragraph(inlineSource(paragraph))]
        case let heading as Heading:
            return [.heading(level: heading.level, text: inlineSource(heading))]
        case let list as UnorderedList:
            return [.unorderedList(list.children.compactMap(listItem))]
        case let list as OrderedList:
            return [.orderedList(start: Int(list.startIndex), items: list.children.compactMap(listItem))]
        case let quote as BlockQuote:
            return [.blockquote(quote.children.flatMap(project))]
        case let code as CodeBlock:
            return [.codeBlock(language: code.language, code: code.code)]
        case let table as Table:
            return [.table(project(table))]
        case is ThematicBreak:
            return [.thematicBreak]
        case let html as HTMLBlock:
            // Raw HTML is deliberately data, never executable UI.
            return [.rawText(html.rawHTML.trimmingCharacters(in: .newlines))]
        default:
            let fallback = markup.format().trimmingCharacters(in: .newlines)
            return fallback.isEmpty ? [] : [.rawText(fallback)]
        }
    }

    private static func listItem(_ markup: Markup) -> MarkdownListItem? {
        guard let item = markup as? ListItem else { return nil }
        let checked: Bool?
        switch item.checkbox {
        case .checked?: checked = true
        case .unchecked?: checked = false
        case nil: checked = nil
        }
        return MarkdownListItem(checked: checked, blocks: item.children.flatMap(project))
    }

    private static func project(_ table: Table) -> MarkdownTable {
        let headers = table.head.cells.map(inlineSource)
        let rows = table.body.rows.map { row in Array(row.cells.map(inlineSource)) }
        let alignments = table.columnAlignments.map { alignment -> MarkdownTable.Alignment? in
            switch alignment {
            case .left?: return .left
            case .center?: return .center
            case .right?: return .right
            case nil: return nil
            }
        }
        return MarkdownTable(headers: Array(headers), rows: Array(rows), alignments: alignments)
    }

    /// Formatting only the inline children preserves emphasis, code and links
    /// without reintroducing the parent block's `#`, `-`, or table delimiters.
    private static func inlineSource(_ markup: Markup) -> String {
        markup.children
            .map(serializeInline)
            .joined()
            .trimmingCharacters(in: .newlines)
    }

    private static func serializeInline(_ markup: Markup) -> String {
        switch markup {
        case let text as Markdown.Text:
            return escapeInlineText(text.string)
        case let strong as Strong:
            return "**\(strong.children.map(serializeInline).joined())**"
        case let emphasis as Emphasis:
            return "*\(emphasis.children.map(serializeInline).joined())*"
        case let strike as Strikethrough:
            return "~~\(strike.children.map(serializeInline).joined())~~"
        case let code as InlineCode:
            return codeSource(code.code)
        case let link as Link:
            let label = link.children.map(serializeInline).joined()
            guard let destination = link.destination else { return label }
            return "[\(label)](\(destination.replacingOccurrences(of: ")", with: "\\)")))"
        case let image as Markdown.Image:
            let alt = image.children.map(serializeInline).joined()
            // Message attachments have a separate, allowlisted native preview
            // path. Inline Markdown must never fetch an arbitrary remote image.
            return alt.isEmpty ? "Image" : alt
        case is SoftBreak:
            return " "
        case is LineBreak:
            return "\n"
        case let html as InlineHTML:
            return escapeInlineText(html.rawHTML)
        default:
            if !markup.isEmpty {
                return markup.children.map(serializeInline).joined()
            }
            return escapeInlineText(markup.format().trimmingCharacters(in: .newlines))
        }
    }

    private static func escapeInlineText(_ text: String) -> String {
        text.reduce(into: "") { result, character in
            if "\\`*_[]~".contains(character) { result.append("\\") }
            result.append(character)
        }
    }

    private static func codeSource(_ code: String) -> String {
        var longestRun = 0
        var currentRun = 0
        for character in code {
            if character == "`" {
                currentRun += 1
                longestRun = max(longestRun, currentRun)
            } else {
                currentRun = 0
            }
        }
        let fence = String(repeating: "`", count: max(1, longestRun + 1))
        let padding = code.hasPrefix("`") || code.hasSuffix("`") ? " " : ""
        return "\(fence)\(padding)\(code)\(padding)\(fence)"
    }
}

public indirect enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case unorderedList([MarkdownListItem])
    case orderedList(start: Int, items: [MarkdownListItem])
    case blockquote([MarkdownBlock])
    case codeBlock(language: String?, code: String)
    case table(MarkdownTable)
    case thematicBreak
    case rawText(String)
}

public struct MarkdownListItem: Equatable, Sendable {
    public let checked: Bool?
    public let blocks: [MarkdownBlock]

    public init(checked: Bool?, blocks: [MarkdownBlock]) {
        self.checked = checked
        self.blocks = blocks
    }
}

public struct MarkdownTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable {
        case left
        case center
        case right
    }

    public let headers: [String]
    public let rows: [[String]]
    public let alignments: [Alignment?]

    public init(headers: [String], rows: [[String]], alignments: [Alignment?]) {
        self.headers = headers
        self.rows = rows
        self.alignments = alignments
    }
}
