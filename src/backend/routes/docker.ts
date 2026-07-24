/**
 * Read/teardown API for a session's Docker Compose services (#264 Phase 2).
 *
 * Lets the UI show what's running and clean up a leak, without going through
 * the agent tool. Teardown here is a human action from the app, so it isn't
 * gated by the tool policy — but it is hard-scoped to Nexus-owned projects, so
 * the endpoint can never take down a stack Nexus didn't start.
 */
import type { FastifyInstance } from 'fastify';
import { composeDown, composeProjectName, isNexusProject, realDockerExec, type DockerExec } from '../docker/compose.js';
import { listServiceGroups, type ServiceGroup } from '../docker/services.js';

export interface DockerRouteOptions {
  /** Whether a Docker daemon is reachable. Defaults to always-true; production
   *  passes the shared availability tracker so the panel matches the tools. */
  isAvailable?: () => boolean;
  exec?: DockerExec;
  /** Injection seam for tests. */
  listGroups?: (exec: DockerExec) => Promise<ServiceGroup[]>;
}

export async function registerDockerRoutes(fastify: FastifyInstance, options: DockerRouteOptions = {}): Promise<void> {
  const isAvailable = options.isAvailable ?? (() => true);
  const exec = options.exec ?? realDockerExec;
  const listGroups = options.listGroups ?? ((e: DockerExec) => listServiceGroups(fastify.db, e));

  fastify.get('/api/docker/services', async (request) => {
    if (!isAvailable()) return { available: false, groups: [] };
    // `?thread=<id>` narrows to one thread's project — for the inline panel in a
    // chat session. The thread → project mapping is the derived compose name, so
    // the filter is computed here rather than trusted from the client.
    const thread = (request.query as { thread?: string } | undefined)?.thread?.trim();
    try {
      const groups = await listGroups(exec);
      if (thread) {
        const project = composeProjectName(thread);
        return { available: true, groups: groups.filter((g) => g.project === project) };
      }
      return { available: true, groups };
    } catch {
      // A daemon that hiccups mid-request shouldn't 500 the panel.
      return { available: true, groups: [] };
    }
  });

  fastify.post('/api/docker/services/:project/down', async (request, reply) => {
    const { project } = request.params as { project: string };
    const name = decodeURIComponent(project ?? '').trim();

    // The one hard rule: this endpoint only ever tears down projects Nexus
    // owns. A caller cannot aim it at an unrelated stack on the machine.
    if (!isNexusProject(name)) {
      reply.code(400);
      return { error: 'Not a Nexus-managed service group.' };
    }
    if (!isAvailable()) {
      reply.code(503);
      return { error: 'Docker is not available.' };
    }

    const result = await composeDown({ projectName: name, exec });
    if (result.code !== 0) {
      reply.code(502);
      return { error: (result.stderr || result.stdout || 'docker compose down failed').trim() };
    }
    return { ok: true, project: name };
  });
}
