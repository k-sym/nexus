/** A bounded FIFO buffer of terminal output, replayed to newly-attached clients. */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly maxBytes = 200_000) {}

  append(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
