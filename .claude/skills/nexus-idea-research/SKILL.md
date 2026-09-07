---
name: nexus-idea-research
description: Run a research brief inside a Nexus Idea Watcher thread and return findings shaped so Keith can pull them apart in the same thread — numbered, sourced, rated, with a recommendation. Use when a message starts with "Research brief:", when Keith says "research this", "dig into", "prior art for", "what are the options for", or asks for a comparison inside an idea dialogue.
---

# Idea research

An idea in Nexus ripens through dialogue. Research is one turn in that dialogue, and its findings are read back in the thread where Keith keeps some and discards the rest. The output shape below exists so that keeping and discarding is easy: every finding stands on its own with its source, and nothing important is buried in a paragraph.

## Steps

1. **Read the whole thread first**, including the seed notes and any earlier findings, so the brief is answered in context and earlier discards are not re-proposed.
2. **Check memory** (`memory_recall`) for prior decisions on the same topic. Keith parks tangents deliberately; some have been researched before.
3. **Follow the brief's source preference.** Official docs and primary sources first, with a link for every fact relied on. Community posts are fine for signals but say when a claim rests on one.
4. **Stop when the brief's "done" is met.** The brief caps the work; more findings past that point lower the signal, and Keith can commission a second brief for what is still open.

## Output shape

```markdown
## Findings
1. **<finding in one line>** — <two or three sentences of substance>. Source: <link>. Confidence: high / medium / low.
2. …

## Options
| Option | What it gives | What it costs | Fit with Nexus |
| … | … | … | … |

## Recommendation
One paragraph: which option and why, in terms of the idea's outcome.

## Open questions
- Each as a question Keith can answer in one line, or a thing to test.
```

Eight findings at most, sources on every one, the whole reply under about 600 words. When the brief asked for one thing and the research shows the framing is wrong, say so under Recommendation rather than answering the question as asked.

## Keep in mind

- The partner's posture in idea threads is read-only: search, fetch, and memory recall. Findings that need a code change are handed to `nexus-idea-graduate` when the idea graduates, not acted on here.
- Nexus is one workspace driving many harnesses across projects; note when a finding applies beyond Nexus so it can be parked as its own idea.
