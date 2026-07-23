/**
 * Trimming captured output to something a context window can hold.
 *
 * Shared because two callers need the identical, slightly subtle behaviour:
 * Docker command output (`docker/compose.ts`) and browser page reads
 * (`browser/page.ts`). Both keep the tail, and both are routinely non-ASCII —
 * Compose's progress uses ✔ and ⠿, and web pages are whatever they are — so a
 * naive byte slice produces replacement characters.
 */

/**
 * Keep the last `maxBytes` of `text`, cut on a character boundary.
 *
 * The tail rather than the head: for command output and page content alike, the
 * interesting part (the error, the newest log lines, the end of the article) is
 * at the end.
 */
export function boundTailText(text: string, maxBytes: number, notice = '[earlier output truncated]'): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let buf = Buffer.from(text, 'utf8').subarray(-maxBytes);
  // A byte-wise cut can land inside a multi-byte character, which would decode
  // to U+FFFD. Skip leading UTF-8 continuation bytes (0b10xxxxxx) so the slice
  // starts on a character boundary.
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  buf = buf.subarray(start);

  const truncated = buf.toString('utf8');
  // Drop a partial first line so the caller isn't handed half an entry.
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
  return `${notice}\n${clean}`;
}
