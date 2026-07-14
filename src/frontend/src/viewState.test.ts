import { describe, it, expect, beforeEach } from 'vitest';
import { loadViewState, saveViewState, VIEW_STATE_KEY } from './viewState';

describe('viewState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips the selection', () => {
    saveViewState({ activeProjectId: 'proj-1', subView: 'chat', activeThreadId: 'thread-9' });
    expect(loadViewState()).toEqual({
      activeProjectId: 'proj-1',
      subView: 'chat',
      activeThreadId: 'thread-9',
    });
  });

  it('returns {} when nothing is stored', () => {
    expect(loadViewState()).toEqual({});
  });

  it('returns {} on malformed JSON instead of throwing', () => {
    localStorage.setItem(VIEW_STATE_KEY, '{not json');
    expect(loadViewState()).toEqual({});
  });

  it('preserves an explicit null thread (no active session)', () => {
    saveViewState({ activeProjectId: 'proj-1', subView: 'kanban', activeThreadId: null });
    expect(loadViewState().activeThreadId).toBeNull();
    expect(loadViewState().subView).toBe('kanban');
  });
});
