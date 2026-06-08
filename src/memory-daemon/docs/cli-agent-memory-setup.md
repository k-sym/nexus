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

## Register the MCP server (one-time, per CLI)
Replace `<ABS>` with the absolute repo path.

- **Claude Code:** `claude mcp add nexus-memory -- node <ABS>/src/memory-daemon/dist/src/mcp/stdio.js`
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
