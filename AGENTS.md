# Repository agent guidance

For tasks involving MCP tools, read `.agents/skills/mcp-servers/SKILL.md`. Its server map is a historical snapshot: check the current configured server labels and discover available tool signatures before using them.

# Subagent model policy

For every `subagent_control` spawn, pass an explicit `model`. Only these routes are permitted:

- `openai/gpt-6-luna`
- `z-ai/glm-5.3-flash`

If a route is rejected, retry only with the other permitted route if it suits the task. If neither works, report the routing error. Never omit `model`, use the default delegate model, or fall back to a third route.

`max` is a reasoning-effort setting, not part of either model ID. When maximum effort is required but the spawn interface cannot set it, prefer `z-ai/glm-5.3-flash` (Z.AI documents `max` as its default). Use `openai/gpt-6-luna` for a max-effort task only if the invocation can explicitly set `reasoning.effort=max`. Do not claim that maximum effort was enforced without confirmation from the invocation or runtime.
