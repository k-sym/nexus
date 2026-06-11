import { describe, expect, test, vi, afterEach } from 'vitest';

import { apiUrl } from './api-base';

declare global {
  interface Window {
    __NEXUS_API__?: string;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiUrl', () => {
  test('keeps relative API URLs in dev', () => {
    expect(apiUrl('/api/projects')).toBe('/api/projects');
  });

  test('uses injected packaged-app API base for API URLs', () => {
    vi.stubGlobal('window', { __NEXUS_API__: 'http://127.0.0.1:4173/api' });

    expect(apiUrl('/api/projects')).toBe('http://127.0.0.1:4173/api/projects');
  });
});
