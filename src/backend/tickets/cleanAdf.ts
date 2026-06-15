/**
 * Turn a Jira ADF (Atlassian Document Format) description into readable plain
 * text for the Tickets preview pane. Images/media are dropped entirely (Jira
 * stays canonical — the user can "Open in Jira" for the rare ticket where a
 * screenshot matters). The frontend renders the result with `whitespace-pre-wrap`.
 *
 * Raw ADF is cached in the DB, so these rules can be revised later (e.g. keep
 * attachment-sized images) without re-fetching from Jira.
 */

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

const MEDIA_TYPES = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);

/** Render inline content (text nodes with marks) of a block node to a string. */
function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    if (MEDIA_TYPES.has(node.type)) continue;
    if (node.type === 'hardBreak') { out += '\n'; continue; }
    if (node.type === 'text') {
      const link = node.marks?.find((m) => m.type === 'link');
      if (link) {
        const href = String((link.attrs as { href?: string } | undefined)?.href ?? '');
        out += node.text && node.text.length > 0 ? node.text : href;
      } else {
        out += node.text ?? '';
      }
      continue;
    }
    // Unknown inline node: fall back to its nested text.
    out += renderInline(node.content);
  }
  return out;
}

/** Render a list (bullet or ordered), one line per item prefixed with a marker. */
function renderList(node: AdfNode, ordered: boolean): string {
  const items = node.content ?? [];
  return items
    .map((item, i) => {
      const marker = ordered ? `${i + 1}. ` : '• ';
      // A listItem's children are usually a single paragraph; flatten them.
      const text = (item.content ?? []).map(renderBlock).filter(Boolean).join(' ');
      return marker + text;
    })
    .join('\n');
}

/** Render a single block node to text (no trailing separator). */
function renderBlock(node: AdfNode): string {
  if (MEDIA_TYPES.has(node.type)) return '';
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return renderInline(node.content);
    case 'blockquote':
    case 'panel':
      return (node.content ?? []).map(renderBlock).filter(Boolean).join('\n');
    case 'bulletList':
      return renderList(node, false);
    case 'orderedList':
      return renderList(node, true);
    case 'codeBlock':
      return renderInline(node.content);
    case 'rule':
      return '';
    case 'table': {
      const rows = node.content ?? [];
      return rows
        .map((row) => (row.content ?? []).map((cell) => renderInline(cell.content)).join('  '))
        .join('\n');
    }
    default:
      return node.content ? (node.content).map(renderBlock).filter(Boolean).join('\n') : (node.text ?? '');
  }
}

/** Top-level: ADF doc → plain text, blocks separated by blank lines. */
export function adfToText(doc: AdfNode | null | undefined): string {
  if (!doc || !doc.content) return '';
  return doc.content
    .map(renderBlock)
    .map((s) => s.replace(/[ \t]+\n/g, '\n').trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}
