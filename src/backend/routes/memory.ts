import { FastifyInstance } from 'fastify';
import { MemoryInput } from '../memory/store';
import { addMemory, getRelevantMemories, getAllMemories, deleteMemory, updateMemory } from '../memory';

export async function registerMemoryRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/projects/:projectId/memories', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { q } = request.query as { q?: string };

    if (q) {
      return getRelevantMemories(db, projectId, q);
    }
    return getAllMemories(db, projectId);
  });

  fastify.post('/api/projects/:projectId/memories', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as Omit<MemoryInput, 'project_id'>;
    return addMemory(db, { ...body, project_id: projectId });
  });

  fastify.put('/api/memories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };
    updateMemory(db, id, content);
    return { success: true };
  });

  fastify.delete('/api/memories/:id', async (request) => {
    const { id } = request.params as { id: string };
    deleteMemory(db, id);
    return { success: true };
  });
}
