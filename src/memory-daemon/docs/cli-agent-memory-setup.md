# Giving CLI agents access to Nexus memory (read-only)

CLI agents (Claude Code, OpenCode, Codex) read shared project memory through the `nexus-memory` MCP
server (`dist/src/mcp/stdio.js`), which talks to the daemon over HTTP. Build the daemon first:
`npm --prefix src/memory-daemon run build`.

## Scoping
The MCP server reads two env vars:
- `NEXUS_MEMORY_PROJECT=<project-slug>` — pins recall to that project (nexus namespace, isolated scope).
- `NEXUS_MEMORY_READONLY=1` — registers only the read tools (recall/search/get/list).

Nexus terminal threads set both automatically (scoped to the thread's project). For an external CLI
session, set them yourself, e.g. `export NEXUS_MEMORY_PROJECT=baker-internal NEXUS_MEMORY_READONLY=1`.

This works with a single **global** registration because the CLI passes its own environment through to
the MCP server subprocess it spawns — so the per-thread (or per-shell) env is what scopes recall, not
the registration. If a CLI is found *not* to propagate env to MCP servers, register with an explicit
env instead (e.g. Claude Code's `--env NEXUS_MEMORY_READONLY=1`). Confirm scoping in the smoke test.

## Register the MCP server (one-time, per CLI)
Replace `<ABS>` with the absolute repo path.

> **Two separate mechanisms — don't conflate them.** Registering the MCP server (below) is a
> **user-level config entry** per CLI; installing the behaviour skill (next section) is **symlinks**
> into each CLI's skill dir. "Global" means *user-scoped config*, **not** running from your home dir
> — the command/edit can be run from anywhere.

- **Claude Code (global):** `claude mcp add nexus-memory --scope user -- node <ABS>/src/memory-daemon/dist/src/mcp/stdio.js`
  — `--scope user` is what makes it global; the default scope is local/project (cwd-dependent).
- **OpenCode** (`~/.config/opencode/opencode.json`):
  ```json
  { "mcp": { "nexus-memory": { "type": "local", "command": ["node", "<ABS>/src/memory-daemon/dist/src/mcp/stdio.js"] } } }
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.nexus_memory]
  command = "node"
  args = ["<ABS>/src/memory-daemon/dist/src/mcp/stdio.js"]
  ```

## Install the behavior skill
Copy or symlink the skill so each CLI discovers it:
```bash
mkdir -p ~/.claude/skills ~/.agents/skills
ln -sf <ABS>/src/memory-daemon/skills/nexus-memory ~/.claude/skills/nexus-memory   # Claude Code + OpenCode read this
ln -sf <ABS>/src/memory-daemon/skills/nexus-memory ~/.agents/skills/nexus-memory   # Codex
```

## Caveats
- **Codex sandbox:** Codex's default `workspace-write` sandbox denies outbound network, which can block
  the MCP server's localhost call to the daemon. Grant network/approval for the daemon call (and test).
  OpenCode and Claude Code are not affected by default.
- Memory writes are intentionally disabled from CLIs in this phase (recall-only).

## Future: remote / cloud agents
Cloud-hosted agents (e.g. Claude Cloud) cannot reach a loopback stdio server. Serving them later means
adding a Streamable-HTTP transport to the same MCP server, fronted by auth (bearer/OAuth) + TLS via a
tunnel (Tailscale/Cloudflare). Not built in this phase; the server is kept transport-agnostic so it's additive.
