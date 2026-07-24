/**
 * The agent's window onto the enabled API helpers (#291).
 *
 * Three read-biased tools, each registered only when its backing provider is
 * live (the memory_recall/Monday precedent — never advertise a tool that can't
 * run):
 *   - web_search  — ranked results, some with inline page text (Brave/Exa)
 *   - web_answer  — a synthesised, cited answer (Perplexity)
 *   - docs_lookup — version-current library docs (Context7)
 *
 * These exist so the model reaches for real search/docs when the task fits,
 * rather than guessing from stale training knowledge or shelling out to curl.
 * The key stays server-side in the deps closures; the model only ever sees the
 * normalised result. A provider error is thrown, which Pi turns into an error
 * tool result the model can read and retry around — it never fails the session.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type, type TProperties } from 'typebox';
import type { HelpersToolDeps, SearchProvider } from '../helpers/resolve.js';
import type { AnswerResponse, DocsResponse, SearchResponse } from '../helpers/types.js';

function formatSearch(res: SearchResponse): string {
  return res.results
    .map((r, i) => {
      const parts = [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`];
      if (r.snippet) parts.push(`   ${r.snippet}`);
      // Exa returns cleaned page text inline; it's the whole reason to prefer
      // it over a raw fetch, so include it rather than making the model chase
      // the URL (there is no fetch tool to chase it with).
      if (r.text) parts.push('   ---', r.text);
      return parts.join('\n');
    })
    .join('\n\n');
}

function formatAnswer(res: AnswerResponse): string {
  const parts = [res.answer.trim()];
  if (res.citations.length > 0) {
    parts.push('', 'Sources:');
    res.citations.forEach((c, i) => parts.push(`[${i + 1}] ${c}`));
  }
  return parts.join('\n');
}

function formatDocs(res: DocsResponse): string {
  return `# ${res.library} (${res.libraryId})\n\n${res.text}`;
}

/** Which tools this dep set would register. Exposed for tests and diagnostics. */
export function helpersToolNames(deps: HelpersToolDeps): string[] {
  const names: string[] = [];
  if (deps.search) names.push('web_search');
  if (deps.answer) names.push('web_answer');
  if (deps.docs) names.push('docs_lookup');
  return names;
}

export function createHelpersExtension(deps: HelpersToolDeps): ExtensionFactory {
  return (pi) => {
    const search = deps.search;
    if (search) {
      // Built as a TProperties record rather than an inline literal so the
      // `provider` field can be added conditionally without collapsing the
      // schema's static type (a conditional spread makes params infer as {}).
      // Offer the choice only when there's one to make; with a single live
      // search provider the argument would just be noise.
      const props: TProperties = {
        query: Type.String({ description: 'What to search the web for.' }),
      };
      if (deps.searchProviders.length > 1) {
        props.provider = Type.Optional(
          Type.Union(deps.searchProviders.map((p) => Type.Literal(p)), {
            description: 'Which search backend to use. Omit to use the configured default.',
          }),
        );
      }

      pi.registerTool({
        name: 'web_search',
        label: 'Web search',
        description:
          'Search the live web and get back ranked results — some with the page text inline. Prefer this '
          + 'over answering from memory when a fact could be current, version-specific, or post-training, and '
          + 'over shelling out to fetch a URL yourself.',
        promptSnippet: 'web_search: search the live web (prefer over guessing or a raw fetch)',
        parameters: Type.Object(props),
        async execute(
          _toolCallId,
          rawParams,
        ): Promise<AgentToolResult<{ status: string; count: number; provider: string }>> {
          // Dynamic schema ⇒ read through a known shape rather than inference.
          const params = rawParams as unknown as { query?: string; provider?: SearchProvider };
          const query = params.query?.trim() ?? '';
          if (!query) throw new Error('web_search needs a non-empty query.');
          const res = await search(query, params.provider);
          if (res.results.length === 0) {
            return {
              content: [{ type: 'text', text: `No web results for: ${query}` }],
              details: { status: 'empty', count: 0, provider: res.provider },
            };
          }
          return {
            content: [{ type: 'text', text: formatSearch(res) }],
            details: { status: 'ok', count: res.results.length, provider: res.provider },
          };
        },
      });
    }

    const answer = deps.answer;
    if (answer) {
      pi.registerTool({
        name: 'web_answer',
        label: 'Web answer',
        description:
          'Ask a question and get a synthesised, cited answer drawn from a live web search. Prefer this over '
          + 'web_search when you want a direct answer with sources rather than a list of links to read yourself.',
        promptSnippet: 'web_answer: get a synthesised, cited answer to a question',
        parameters: Type.Object({
          question: Type.String({ description: 'The question to answer, in full.' }),
        }),
        async execute(
          _toolCallId,
          params,
        ): Promise<AgentToolResult<{ status: string; citations: number }>> {
          const question = params.question?.trim() ?? '';
          if (!question) throw new Error('web_answer needs a non-empty question.');
          const res = await answer(question);
          if (!res.answer.trim()) {
            return {
              content: [{ type: 'text', text: `No answer returned for: ${question}` }],
              details: { status: 'empty', citations: 0 },
            };
          }
          return {
            content: [{ type: 'text', text: formatAnswer(res) }],
            details: { status: 'ok', citations: res.citations.length },
          };
        },
      });
    }

    const docs = deps.docs;
    if (docs) {
      pi.registerTool({
        name: 'docs_lookup',
        label: 'Docs lookup',
        description:
          'Fetch current documentation for a library or framework by name, optionally scoped to a topic. Use '
          + 'it to ground code on the version-accurate API instead of relying on possibly-stale training knowledge.',
        promptSnippet: 'docs_lookup: fetch current library/framework documentation',
        parameters: Type.Object({
          library: Type.String({ description: 'Library or framework name, e.g. "next.js" or "fastify".' }),
          topic: Type.Optional(
            Type.String({ description: 'Narrow the docs to a topic, e.g. "routing" or "useState".' }),
          ),
        }),
        async execute(
          _toolCallId,
          params,
        ): Promise<AgentToolResult<{ status: string; library_id: string }>> {
          const library = params.library?.trim() ?? '';
          if (!library) throw new Error('docs_lookup needs a non-empty library.');
          const res = await docs(library, params.topic?.trim() || undefined);
          if (!res.text.trim()) {
            return {
              content: [{ type: 'text', text: `No documentation snippets found for ${res.library}.` }],
              details: { status: 'empty', library_id: res.libraryId },
            };
          }
          return {
            content: [{ type: 'text', text: formatDocs(res) }],
            details: { status: 'ok', library_id: res.libraryId },
          };
        },
      });
    }
  };
}
