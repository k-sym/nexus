import { describe, expect, it } from 'vitest';
import { AGENT_RUN_CUSTOM_TYPE } from '@nexus/shared';

describe('agent run contract', () => {
  it('uses a stable Pi custom entry type', () => {
    expect(AGENT_RUN_CUSTOM_TYPE).toBe('nexus.agent_run');
  });
});
