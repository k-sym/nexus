import XCTest
@testable import NexusCore

final class MarkdownDocumentTests: XCTestCase {
    func testProjectsGitHubTableWithoutPipeSource() {
        let document = MarkdownDocument(parsing: """
        | Repo | Commit | Contents |
        | --- | :---: | ---: |
        | wise-codeigniter | `4088421` | migration, builder UI, **clone fixes** |
        | wise-app | `6516dc7` | iOS |
        """)

        guard case .table(let table) = document.blocks.first else {
            return XCTFail("Expected a table block, got \(document.blocks)")
        }
        XCTAssertEqual(table.headers, ["Repo", "Commit", "Contents"])
        XCTAssertEqual(table.rows, [
            ["wise-codeigniter", "`4088421`", "migration, builder UI, **clone fixes**"],
            ["wise-app", "`6516dc7`", "iOS"],
        ])
        XCTAssertEqual(table.alignments, [nil, .center, .right])
    }

    func testProjectsCommonBlockTypesAndInlineFormatting() {
        let document = MarkdownDocument(parsing: """
        ## What's built

        Paragraph with **strong**, _emphasis_, [`link`](https://example.com), and `code`.

        - First
        - [x] Complete

        3. Third
        4. Fourth

        > Quoted **text**.

        ```swift
        let answer = 42
        ```

        ---
        """)

        XCTAssertEqual(document.blocks[0], .heading(level: 2, text: "What's built"))
        XCTAssertEqual(
            document.blocks[1],
            .paragraph("Paragraph with **strong**, *emphasis*, [`link`](https://example.com), and `code`.")
        )

        guard case .unorderedList(let bullets) = document.blocks[2] else {
            return XCTFail("Expected unordered list")
        }
        XCTAssertEqual(bullets.map(\.checked), [nil, true])
        XCTAssertEqual(bullets.map(\.blocks), [[.paragraph("First")], [.paragraph("Complete")]])

        guard case .orderedList(let start, let numbered) = document.blocks[3] else {
            return XCTFail("Expected ordered list")
        }
        XCTAssertEqual(start, 3)
        XCTAssertEqual(numbered.map(\.blocks), [[.paragraph("Third")], [.paragraph("Fourth")]])

        XCTAssertEqual(document.blocks[4], .blockquote([.paragraph("Quoted **text**.")]))
        XCTAssertEqual(document.blocks[5], .codeBlock(language: "swift", code: "let answer = 42\n"))
        XCTAssertEqual(document.blocks[6], .thematicBreak)
    }

    func testRawHTMLRemainsInertText() {
        let document = MarkdownDocument(parsing: "<script>alert('no')</script>")
        XCTAssertEqual(document.blocks, [.rawText("<script>alert('no')</script>")])
    }

    func testRemoteMarkdownImageProjectsToAltTextOnly() {
        let document = MarkdownDocument(parsing: "Before ![build graph](https://tracker.invalid/pixel.png) after")
        XCTAssertEqual(document.blocks, [.paragraph("Before build graph after")])
    }
}
