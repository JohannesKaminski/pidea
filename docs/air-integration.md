# Air in IDEs integration: findings and plan

Status: research done 2026-11-12, nothing implemented yet. Every protocol-level claim below about Air is unverified until the spike in step 1 confirms it.

## What Air in IDEs is

- A JetBrains plugin for agentic development (Marketplace in 2026.2, bundled from 2026.3). Experimental; AI Assistant stays available as a separate plugin.
- Talks to agents over ACP. Agents come from local detection, the ACP agent registry, or custom entries in `~/.jetbrains/acp.json`, the same file and format `pidea setup` writes. Custom agents need no JetBrains AI licence.
- Presets: agent, model, effort, operation mode ("values come from the agent"), a Plan mode checkbox, and injected instructions sent before the first prompt.
- Sessions: start, continue, fork. A fork goes into a new temporary Git worktree (default root `~/.air/worktrees/temporary`) or the same workspace. One session list across projects, with cost per session from agent-reported figures.
- Review: code notes in the gutter are attached to a session as prompt attachments. Commit message generation runs a hidden service session with a lightweight model and low effort. Merge conflicts open a new session scoped to the conflicting files.
- Agent questions: an interactive form with numbered choices that pauses the session.
- MCP servers: one `~/.jetbrains/mcp/mcp.json` in `mcpServers` format, passed to every new session of an agent that supports MCP. Transports: stdio and HTTP. SSE is not supported.
- IDE tools: the `jetbrains_air_ide` MCP server, "tools usually exposed through an `execute_tool` router".
- Skills: `SKILL.md` folders in IDE storage, `<project>/.agents/skills`, or agent-specific folders. Attached in a prompt with `$`.

## What already fits

pidea already covers session list, load, resume, fork, close and delete, the model selector, the thinking level as a `thought_level` config option, tool approval through `session/request_permission`, `usage_update` with context occupancy and cost, form elicitation for pi input requests, and terminal auth.

## Spike results (2026-11-12, PyCharm 2026.3, build 263.7307.206)

Sources: `~/.pi/pidea/acp-debug.log` and `idea.log`, with `PIDEA_DEBUG_ACP=1` and `PIDEA_DEBUG_BRIDGE=1`. Air identifies as `clientInfo.name = "air-plugin:pycharm"`; AI Assistant chat in the same IDE identifies as `JetBrains.PyCharm`.

1. **IDE tools: Air gives one tool.** Air sends the IDE server as stdio `jetbrains_air_ide` (same `pycharm stdioMcpServer` launcher with `IJ_MCP_SERVER_PORT`, plus a new `IJ_MCP_LAUNCH_ORIGIN`). For that session the IDE registers `Adding Tools: 1`; for AI Assistant chat it registers 66. The one tool is presumably the `execute_tool` router, which pidea deny-lists, so pi most likely has no IDE tools in Air.
2. **HTTP MCP: Air holds back a private server.** `idea.log`: "ACP agent acp.pidea has no HTTP MCP capability; the session receives no private server". Air offers more over HTTP than the stdio fallback.
3. **No editor file access.** Air declares `fs.readTextFile: false` and `fs.writeTextFile: false` (AI Assistant chat declares both `true`). pidea's "Through the editor" file access is unavailable; pi reads and writes the disk.
4. **Startup notices are dropped.** pidea sends the startup block and a `usage_update` during `session/new`, before Air enables the session: "Dropped a pre-enable ACP session update". The user never sees the startup block, including IDE bridge problems.
5. **Effort selector is empty.** Air warns "The session metadata has no reasoningEffortSupported value" on every prompt; pidea's `thought_level` option does not fill Air's Effort control.
6. **Skills come through `_meta.additionalRoots`.** Every `session/new` and `session/prompt` carries `_meta.additionalRoots`, a folder under the IDE cache whose `.agents/skills/` holds the skills Air enabled (IDE-bundled ones such as `jupyter`, `pycharm-code-analysis`, and imported ones such as `writing-for-agents`). pidea ignores it, so pi doesn't see them. A typed `$writing` arrived as the literal text `$writing`. pidea's own `/skill:tdd` worked as text.
7. **Attachments arrive as plain text.** `@file:` mentions and an editor selection arrived inlined in the single text block (`contextItems=0`, `explicitContextItems=1` for the selection), with no `resource_link`. The display text is in `_meta.jetbrains.displayText`. A code note sent from a review arrived as a 511-character text block with empty display text.
8. **Air-specific capabilities.** `clientCapabilities` also carries `plan: {}`, `subagents: {}`, `_meta.permission.features: ["request_presentation"]`, `_meta.terminal_output_delta`, `_meta.media-rendering`, and `_meta.jetbrains.air.capabilities`: `sessionFailure`, `recommendedValue`, `nativeSubagentSessions`, `asyncTasks`, `backgroundSubagents`, `agentFileChangeReport`, `planFile`, `diffPatch`, `rawInputRendering`, `planContentDelta`, `modelProviderGroups`, `loadReplayEnd`, `sessionIndex`. None of these are documented publicly.
9. **Session list polling.** Air calls `session/list` once a minute for every open project. It also calls `providers/list` on connect and pre-creates a session per open project.
10. **Session diff.** Opening a review logged "Session diff file is unavailable" for the changed file. Cause not known; possibly tied to `agentFileChangeReport`.
11. **No fork option.** Air offered no Fork Session action for pidea sessions, although pidea advertises `sessionCapabilities.fork`. What Air needs to offer it is unknown.
12. **Not tested:** tool approval prompts and input requests.

## Gaps and plan

1. **Spike: record what Air sends.** Run pidea in Air with `PIDEA_DEBUG_ACP=1` and `PIDEA_DEBUG_BRIDGE=1`. Record the `initialize` client capabilities (fs, terminal, elicitation, Mermaid), the `session/new` MCP descriptors, the `cwd` of a worktree fork, and how an attached `$skill` and code notes arrive in `session/prompt`. All later steps depend on this.
2. **IDE tools behind `execute_tool`.** `src/acp/mcp-bridge.ts` deny-lists `execute_tool`. If Air routes its IDE tools through it, pi gets almost no IDE tools, `PIDEA_IDE_MODE=required` blocks and `prefer` falls back. Plan: discover the routed tools and expose each as its own `ide_*` tool, applying the allow and deny lists to the routed names instead of allowing `execute_tool` as a whole.
3. **Worktree forks (on hold).** Air offers no fork for pidea (spike result 11). Find out what it needs to offer one. Once it does, test that a fork into a temporary worktree runs pi in the worktree's `cwd`, since pi stores sessions per working directory.
4. **HTTP MCP transport.** pidea advertises `mcpCapabilities: { http: false }`, so Air's remote servers from `mcp.json` are not passed on. Plan: add a streamable-HTTP MCP client to the bridge.
5. **Operation modes and plan mode (decision needed).** pidea sends no session modes. Options: expose tool approval as modes, and/or add a plan mode (read-only tools plus planning prompt, possibly plan updates). Also confirm Air's Effort slider maps to the `thought_level` option.
6. **Skills.** Load the skills under `_meta.additionalRoots/*/.agents/skills` into the pi session (spike result 6). Confirm whether pi also loads `<project>/.agents/skills` (unverified).
7. **ACP registry listing (decision needed).** Upstream `pi-acp` is listed as npx `pi-acp@0.0.34`. Listing pidea needs an npm release (it ships as a GitHub tarball today). The npx entry runs on the system Node, not pi's Node, and cannot install pi. Registry auto-updates would overlap with `pidea update`. Terminal auth already meets the registry's auth requirement.
8. **Smaller items.**
   - Service sessions (commit messages, merge conflicts): suppress the startup block and update notice.
   - Verify that pi input requests show up as Air's question forms.
   - README: add an Air section (same `acp.json`, MCP from `mcp.json`, known gaps from step 1).
9. **Notices before the session is enabled.** Delay the startup block and the first `usage_update` until after the `session/new` response (spike result 4).
10. **Effort.** Find out which capability or config option fills Air's Effort control (spike result 5).
11. **No editor file access in Air.** Air declares no `fs` support (spike result 3). Decide whether IntelliJ-first mode replaces it there once the IDE tools work.

## Sources

- Air in IDEs docs: <https://www.jetbrains.com/help/air/air-in-ides-overview.html> and the linked pages on agents, sessions, interaction, review, authorization, extending agents, presets and settings.
- ACP agent registry: <https://github.com/agentclientprotocol/registry> (`FORMAT.md`, `AUTHENTICATION.md`, `CONTRIBUTING.md`, `pi-acp/agent.json`).
