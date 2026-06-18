import type { NexusConfig } from '@nexus/shared';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.js';
import { resolveSignalFilterConfig } from './config.js';
import { projectToolResultMessages } from './messages.js';

type ConfigLoader = () => NexusConfig;

export function registerSignalFilterHandlers(
  pi: ExtensionAPI,
  repoPath: string,
  getConfig: ConfigLoader = loadConfig,
): void {
  pi.on('context', (event) => {
    try {
      const config = resolveSignalFilterConfig(getConfig(), repoPath);
      return { messages: projectToolResultMessages(event.messages, repoPath, config).messages };
    } catch {
      return { messages: event.messages };
    }
  });

  pi.on('session_before_compact', (event) => {
    try {
      const config = resolveSignalFilterConfig(getConfig(), repoPath);
      const messagesToSummarize = projectToolResultMessages(
        event.preparation.messagesToSummarize,
        repoPath,
        config,
      ).messages;
      const turnPrefixMessages = projectToolResultMessages(
        event.preparation.turnPrefixMessages,
        repoPath,
        config,
      ).messages;
      event.preparation.messagesToSummarize = messagesToSummarize;
      event.preparation.turnPrefixMessages = turnPrefixMessages;
    } catch {
      // Fail open: Pi keeps the original compaction preparation.
    }
  });
}

export function createSignalFilterExtension(
  repoPath: string,
  getConfig: ConfigLoader = loadConfig,
): ExtensionFactory {
  return (pi) => registerSignalFilterHandlers(pi, repoPath, getConfig);
}
