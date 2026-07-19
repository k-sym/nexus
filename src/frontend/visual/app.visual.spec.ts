import { expect, test, type Page, type Route } from '@playwright/test';

const sessions = [
  { id: 'session-1', title: 'Release readiness', status: 'idle', latestRun: null },
  { id: 'session-2', title: 'Dependency watch', status: 'idle', latestRun: null },
];

const fixtures: Record<string, unknown> = {
  '/api/projects': [],
  '/api/chat/active-runs': { activeThreadIds: [], runs: [] },
  '/api/activity': {
    running: [],
    recent: [],
    counts: { running: 0, succeeded: 12, failed: 1, cancelled: 0 },
  },
  '/api/mission-control': {
    memory: {
      ok: true,
      memories: 248,
      jobs: { pending: 2, dead: 0 },
      models: { gen: true, embed: true, rerank: true },
    },
    modelCounts: { active: 4, available: 6 },
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet', configured: true, contextWindow: 200000, maxTokens: 64000 },
      { provider: 'openai', id: 'gpt-5.6', name: 'GPT-5.6', configured: true, contextWindow: 256000, maxTokens: 64000 },
      { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', configured: false, contextWindow: 1000000, maxTokens: 64000 },
    ],
    stats: {
      claude: { ok: true, value: '72%', caption: 'session remaining', source: 'local usage cache' },
      codex: { ok: true, value: '84%', caption: 'weekly remaining', source: 'local usage cache' },
      openrouter: { ok: true, value: '$18.42', caption: 'credit balance', source: 'OpenRouter' },
    },
  },
  '/api/settings': {
    server: { port: 4173, url: '', token: '${NEXUS_BACKEND_TOKEN}' },
    assistant: { url: 'https://assistant.example.test/v1', api_key: '${ASSISTANT_API_KEY}' },
    models: { local: { base_url: 'http://127.0.0.1:8081/v1', api_key: '', display_name: 'Local Model', chat_model: 'qwen2.5-coder:7b', supports_images: true } },
    memory: { auto_inject: { enabled: true, max_memories: 5, token_budget: 1000 } },
    jira: { enabled: false, user: '', instance: '', project: '', poll_minutes: 15 },
    github: { enabled: true },
  },
  '/api/trust': {
    services: [{ name: 'Backend', url: 'http://127.0.0.1:4173', loopback: true }],
    storage: [],
    secrets: {},
    outbound: [],
    memory: {
      namespaces: ['nexus'],
      autoInject: { enabled: true, maxMemories: 5, tokenBudget: 1000 },
      archive: { mode: 'manual', destination: 'nexus', removesHotThreadAfterSuccess: true },
    },
    telemetry: { applicationTelemetry: false, statement: 'No application telemetry' },
  },
  '/api/auth/status': { providers: [] },
  '/api/models': { models: [], allModels: [], enabledModelKeys: [], customized: false },
  '/api/notifications': [],
  '/api/assistant/sessions': { sessions },
  '/api/assistant/sessions/session-1': {
    session: sessions[0],
    messages: [
      { id: 'message-1', role: 'user', content: 'Check the release candidate and summarise any blockers.', created_at: '2026-07-19T09:00:00.000Z' },
      { id: 'message-2', role: 'assistant', content: 'All required checks pass. No release blockers remain.', created_at: '2026-07-19T09:01:00.000Z' },
    ],
    latestRun: null,
  },
};

async function fulfillApi(route: Route) {
  const url = new URL(route.request().url());
  const fixture = fixtures[url.pathname];
  if (fixture === undefined) {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `No visual fixture for ${url.pathname}` }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
}

async function openApp(page: Page) {
  await page.route('**/api/**', fulfillApi);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByText('248')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('nexus:ambient-motion', 'off');
  });
  await openApp(page);
});

test('mission control desktop', async ({ page }) => {
  await expect(page).toHaveScreenshot('mission-control.png');
});

test('assistant desktop', async ({ page }) => {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByText('All required checks pass. No release blockers remain.')).toBeVisible();
  await expect(page).toHaveScreenshot('assistant.png');
});

test('settings desktop', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('input[value="https://assistant.example.test/v1"]')).toBeVisible();
  await expect(page).toHaveScreenshot('settings.png');
});

test('new project modal', async ({ page }) => {
  await page.getByRole('button', { name: '⌘K', exact: true }).click();
  await page.getByText('New project…', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
  await expect(page).toHaveScreenshot('new-project-modal.png');
});
