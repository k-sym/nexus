/**
 * `docker_service` — the agent's handle on this project's local stack.
 *
 * Registered only when Docker is actually reachable and the project has opted
 * in, following the `memory_recall` / Monday precedent: a session never
 * advertises a tool that cannot run.
 *
 * The model reads the README to learn what the project needs; that part needed
 * no code. What it gets here is a *disciplined* way to act on it — detached
 * starts, a per-thread compose project so two threads on one repo cannot fight,
 * bounded output, and a compose file it cannot point outside the repo.
 *
 * Part of #264.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  ComposeFileError,
  composeDown,
  composeLogs,
  composeProjectName,
  composeStatus,
  composeUp,
  resolveComposeFile,
  DEFAULT_LOG_TAIL,
  MAX_LOG_TAIL,
  type DockerExec,
} from '../docker/compose.js';

export interface DockerToolDeps {
  /** The thread whose compose project these commands are pinned to. */
  threadId: string;
  /** The project directory. Compose runs here and no compose file may escape it. */
  cwd: string;
  exec?: DockerExec;
  /** Called after a successful `up`, so the session's services can be torn
   *  down later even if the model never calls `down` itself. */
  onStarted?: (projectName: string, cwd: string) => void;
}

const DockerServiceSchema = Type.Object({
  action: Type.Union([
    Type.Literal('up'),
    Type.Literal('down'),
    Type.Literal('status'),
    Type.Literal('logs'),
  ], {
    description:
      'up: start services in the background. down: stop and remove them. '
      + 'status: what is running. logs: recent output.',
  }),
  services: Type.Optional(Type.Array(Type.String(), {
    description: 'Service names from the compose file. Omit for all services.',
  })),
  compose_file: Type.Optional(Type.String({
    description:
      'Compose file path, relative to the project directory. Omit to let Compose find it. '
      + 'Paths outside the project directory are refused.',
  })),
  tail: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_LOG_TAIL,
    description: `Log lines per service (logs only, default ${DEFAULT_LOG_TAIL}).`,
  })),
});

export interface DockerServiceDetails {
  status: 'ok' | 'error';
  action: string;
  projectName: string;
  exitCode: number;
}

/** Join stdout and stderr into what the model should read. Compose writes its
 *  progress (pulling, creating, starting) to stderr even on success, so the
 *  stream something arrived on says nothing about whether it went well. */
function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();
}

export function createDockerExtension(deps: DockerToolDeps): ExtensionFactory {
  const projectName = composeProjectName(deps.threadId);

  return (pi) => {
    pi.registerTool({
      name: 'docker_service',
      label: 'Docker services',
      description:
        "Start, stop, and inspect this project's local Docker Compose services — the ones its README "
        + 'says you need in order to run or test it. Services start in the background; this never blocks '
        + 'waiting on a container. They are scoped to this session, so they cannot collide with another '
        + "session working on the same repo. Use it when you need the project's stack actually running "
        + 'to verify something; skip it for work the source alone answers.',
      promptSnippet: "docker_service: start/stop/inspect this project's local Docker Compose services",
      parameters: DockerServiceSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<DockerServiceDetails>> {
        // Pi's agent loop turns a throw into an error tool result and continues
        // the turn, so throw rather than returning a pseudo-error to parse.
        let composeFile: string | undefined;
        try {
          composeFile = await resolveComposeFile(deps.cwd, params.compose_file);
        } catch (error) {
          if (error instanceof ComposeFileError) throw error;
          throw new Error('compose_file could not be resolved.');
        }

        const options = { cwd: deps.cwd, projectName, composeFile, exec: deps.exec };
        const services = (params.services ?? []).map((s) => s.trim()).filter(Boolean);

        const result = await (() => {
          switch (params.action) {
            case 'up': return composeUp(options, services);
            case 'down': return composeDown(options);
            case 'status': return composeStatus(options);
            case 'logs': return composeLogs(options, services, params.tail ?? DEFAULT_LOG_TAIL);
          }
        })();

        const output = combineOutput(result.stdout, result.stderr);
        const details: DockerServiceDetails = {
          status: result.code === 0 ? 'ok' : 'error',
          action: params.action,
          projectName,
          exitCode: result.code,
        };

        if (result.code !== 0) {
          // A failed compose command is the model's problem to solve (a missing
          // file, a port clash, a bad service name), so hand back the message
          // rather than a bare exit code.
          throw new Error(output || `docker compose ${params.action} failed with exit code ${result.code}.`);
        }

        // Record only on success, and only for `up`: a failed start may still
        // have created containers, but the sweep finds those by project name
        // anyway, and recording a failure would imply we know what is running.
        if (params.action === 'up') deps.onStarted?.(projectName, deps.cwd);

        return {
          content: [{
            type: 'text',
            text: output || `docker compose ${params.action} completed (project ${projectName}).`,
          }],
          details,
        };
      },
    });
  };
}
