import '@testing-library/jest-dom';

// jsdom under vitest does not expose the Web Storage API — `window.localStorage`
// and `window.sessionStorage` are undefined, which breaks any component or test
// that reads/writes them (e.g. appearance prefs, sidebar width). Install a
// minimal in-memory Storage so tests get real, per-run isolated storage.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof window.localStorage === 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}

if (typeof window.sessionStorage === 'undefined') {
  Object.defineProperty(window, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}
