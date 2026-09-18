# Agent integration

Design Trace exposes its existing domain services over a local stdio MCP adapter. The adapter can query, plan, execute, validate, build bundles, publish and propose compensating changes. It intentionally cannot approve either review stage.

## Start the MCP server

Build the project first, then configure an MCP client with an explicit kernel data directory and project ID:

```json
{
  "mcpServers": {
    "design-trace": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/design-trace/dist/src/mcp/stdio.js",
        "--data",
        "C:/absolute/path/to/kernel-data",
        "--project",
        "your-project-id"
      ]
    }
  }
}
```

Run the independent operator channel separately:

```powershell
node dist/src/cli.js operator-server --data C:/absolute/path/to/kernel-data --project your-project-id
```

The MCP `request_review` result contains a relative `review_path`. Open it under the loopback origin printed by the operator server. Approval is never available as an MCP tool.

## Skill

The repository-local [`skills/design-trace/SKILL.md`](../skills/design-trace/SKILL.md) guides an Agent through queries, ordinary changes and compensating reverts. Install or link that folder using the conventions of the Agent host.

## Verified trial scope

Automated integration tests cover protocol initialization, tool discovery, read-only Rule queries, cancellation, absence of approval capabilities, a complete update publication and a complete compensation publication. The two publications use the deterministic death-penalty fixture; they are engineering trials, not evidence from a real game project.
