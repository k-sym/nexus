import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Persona, PersonaConfig } from '@nexus/shared';
import { getNexusDir } from '../config';
import { parsePersonaVisual } from '../persona-visual';
import { resolveLaunchCommand } from '../pty/resolve-launch';

export async function registerPersonaRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const personasDir = path.join(getNexusDir(), 'personas');

  function loadPersonaFromDisk(slug: string): PersonaConfig | null {
    const filePath = path.join(personasDir, `${slug}.yaml`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(raw) as PersonaConfig;
  }

  function savePersonaToDisk(config: PersonaConfig): void {
    const filePath = path.join(personasDir, `${config.slug}.yaml`);
    fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: 120, noRefs: true }), 'utf-8');
  }

  fastify.get('/api/personas', async () => {
    const rows = db.prepare('SELECT * FROM personas ORDER BY name ASC').all() as Persona[];
    return rows.map(p => ({ ...p, ...parsePersonaVisual(p.config_yaml) }));
  });

  fastify.get('/api/personas/:slug', async (request) => {
    const { slug } = request.params as { slug: string };
    const config = loadPersonaFromDisk(slug);
    if (!config) { const err = new Error('Persona not found') as any; err.statusCode = 404; throw err; }
    return config;
  });

  fastify.get('/api/personas/:slug/launch-command', async (request) => {
    const { slug } = request.params as { slug: string };
    const row = db.prepare('SELECT config_yaml FROM personas WHERE slug = ?').get(slug) as { config_yaml: string } | undefined;
    if (!row) return { command: '' };
    const command = resolveLaunchCommand(db, row.config_yaml);
    return { command };
  });

  fastify.post('/api/personas', async (request) => {
    const body = request.body as PersonaConfig;
    const now = new Date().toISOString();

    savePersonaToDisk(body);

    const persona: Persona = {
      id: uuid(),
      name: body.name,
      slug: body.slug,
      config_yaml: yaml.dump(body),
      created_at: now,
    };

    db.prepare('INSERT OR REPLACE INTO personas (id, name, slug, config_yaml, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(persona.id, persona.name, persona.slug, persona.config_yaml, persona.created_at);

    return persona;
  });

  fastify.delete('/api/personas/:slug', async (request) => {
    const { slug } = request.params as { slug: string };
    const filePath = path.join(personasDir, `${slug}.yaml`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM personas WHERE slug = ?').run(slug);
    return { success: true };
  });
}
