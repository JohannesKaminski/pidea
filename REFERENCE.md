# pidea reference

How pidea maps the Agent Client Protocol (ACP) onto pi, for ACP client authors and anyone who wants the details. For installing and using pidea, see the [README](README.md).

pidea runs as an ACP server over stdio. Each ACP session starts one `pi --mode rpc` subprocess, and pidea translates messages between the client and pi. It loads its bundled pi extensions (IDE bridge, tool approval, editor file access, client hints) into every pi session it starts.

## Sessions

pidea covers the session surface: `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/fork`, `session/resume`, `session/close`, `session/delete`. pi keeps its own session files. pidea keeps a small map at `~/.pi/pidea/session-map.json` so a load can reattach to the stored session.

Reopening a chat (IntelliJ uses `session/load`) replays the history from pi's stored session, tool calls included, with the same titles and kinds as live.

Clients that render Mermaid diagrams (IntelliJ declares this) get a hint in pi's system prompt, so pi can answer with diagrams. When pi names the session, the chat title follows. When pi changes the thinking level on its own (an extension, `/thinking`), the thinking selector follows. A failing pi extension shows up as a notice in the chat instead of failing silently.

### Startup block

Each session starts with a startup block: adapter build, pi version, loaded context, skills, prompts, and extensions. It follows pi's `quietStartup` setting: `true` hides it, and `"header"` keeps the version lines and hides the listing. IDE bridge problems still show.

The package version does not change between local builds, so the startup block and `initialize` also report the build revision (git commit).

### Update notice

At the first session of an adapter process, pidea checks in the background whether a newer pidea release (GitHub `releases/latest`) or a newer pi (`npm view`) exists, and posts one chat line if so. Each lookup gives up after 3 seconds and fails silently; the result is cached for 24 hours in `~/.pi/pidea/update-check.json`. Session start never waits for it. `PIDEA_UPDATE_CHECK=0` turns it off.

## Session settings

| Setting       | Values                                                              | Default            | Environment default                   |
| ------------- | ------------------------------------------------------------------- | ------------------ | ------------------------------------- |
| Model         | pi's available models                                               | pi's default       |                                       |
| Thinking      | the levels the current model supports                               | pi's default       |                                       |
| Tool approval | Off, Ask for edits & commands, Ask for everything                   | Off                | `PIDEA_TOOL_APPROVAL=off\|edits\|all` |
| File access   | Through the editor, Disk (only with client file read/write support) | Through the editor | `PIDEA_FILE_ACCESS=disk\|editor`      |

IntelliJ applies setting changes right before the next prompt.

**Thinking** is a `thought_level` config option. It is not sent as session modes, so clients show one thinking selector, and pidea does not handle `session/set_mode`. The model selector works through a mapping from pi models to ACP provider info. pi keeps provider credentials outside the RPC surface.

**Tool approval.** pi has no approval step of its own. A bundled pi extension pauses each tool call that needs approval and asks the client through `session/request_permission`, attached to that tool call, with Allow, Always allow (that tool, for the rest of the session), and Reject. A rejected tool does not run. "Ask for edits & commands" lets read, grep, find, and ls run without asking.

**File access.** Through the editor, pi's read, edit, and write tools go through the client's `fs/read_text_file` and `fs/write_text_file`: pi sees unsaved changes, and its edits land in the editor, where you can undo them. In IntelliJ these writes also reach the disk, so later shell commands see them. Writing a file through the editor saves that file, including unsaved changes you had in it. Search tools (grep, find, ls), shell commands, and images keep using the disk.

## Streaming and tool calls

Assistant text streams as `agent_message_chunk`. Reasoning streams as `agent_thought_chunk` when the provider sends it. Every chunk carries a `messageId`: the thinking and text of one pi reply share one, and each adapter notice and replayed message gets its own.

Tool runs map to `tool_call` and `tool_call_update` with the pi tool `name`, an ACP kind, and a readable title built from the arguments: `Read src/a.ts (lines 10–14)`, `Search for "TODO" in src`, `List src`, `Edit README.md`. Bash calls use the command as the title and stream their output as a terminal. A single read-only command (`ls`, `grep`, `rg`, `find`, `cat`, `head`, …, without pipes, chaining, or redirection) gets the search or read kind; anything else stays execute. Extension and IDE tools keep their pi name as the title. Images in tool results (pi's read tool on an image file, images generated in codemode with `models.generateImages()`) reach the client as image content.

pi enables only read, bash, edit, and write by default. Add `"defaultTools": ["+grep", "+find", "+ls"]` to `~/.pi/agent/settings.json` for dedicated search tools; otherwise pi searches through bash.

Edit events carry a file location when pi reports a path. pidea resolves relative paths against the session working directory. For text edits it finds the changed line from one unique match and reports a structured diff.

## Turn outcomes

A turn ends with `max_tokens` when the model hit its output limit and `cancelled` when it was stopped. A failed turn (provider error, pi crash) returns a JSON-RPC error with pi's message; IntelliJ shows it above the input box. Errors pi retries on its own, and context overflows it recovers from by compacting, don't end the turn: the chat shows retry and compaction notices instead.

## Usage and cost

When a turn settles, pidea makes one `get_session_stats` call and reports two things from it. Context window occupancy from pi `contextUsage`, with the cumulative session cost in USD, goes out as an ACP `usage_update` before the prompt resolves. Cumulative token use and cost go on the unstable `usage` field of the prompt response. The call waits at most 1 second. If it fails or times out, the turn still ends and both reports are left out. A turn that ends without settling (pi error, process exit) fetches the stats once for the `usage` field only.

pidea also sends `usage_update` on `session/new` and `session/load`, and after a model switch. Right after compaction pi has no trusted token count, so the client keeps the previous value.

## Attached files and selections

IntelliJ attaches a file as a link and an editor selection as a pointer in byte offsets, not as text. pidea resolves the pointer before pi sees the prompt: it reads the file the way the File access setting says (through the editor, unsaved changes included, or from disk), and gives pi the selected code with its file and line range. A pointer that doesn't fit the file passes through unchanged. Embedded context (`PIDEA_ENABLE_EMBEDDED_CONTEXT`) makes no difference in IntelliJ, which sends the same blocks either way.

## Input requests

Text input requests from pi extensions use ACP elicitation when the client declares form elicitation in `initialize`; otherwise they are cancelled with a visible notice. Requests that fit permissions route through ACP permissions. An editor request shows a cancellation notice because elicitation forms hold primitive fields only.

## Slash commands

Slash commands load file-based prompts from pi and a set of built-ins: `/compact`, `/export`, `/session`, `/name`, `/queue`, `/changelog`, `/steering`, `/follow-up`. Skills appear as `/skill:<name>` when enabled in pi settings. `/compact` on a session too small to compact answers in the chat.

## JetBrains IDE bridge

IntelliJ sends its built-in MCP server descriptor with each chat (with `use_idea_mcp` enabled). pidea exposes those IDE tools to pi as `ide_<server>_<tool>` extension tools.

The bridge opens a direct MCP-over-SSE client against `http://127.0.0.1:<IJ_MCP_SERVER_PORT>/sse` when the descriptor carries that port. It starts the stdio child only when that endpoint is unreachable.

Two allowlists guard the IDE tools. The IDE side reads `idea_mcp_allowed_tools` from `~/.jetbrains/acp.json`: it acts as a deny-all mask plus the named tools, and an omitted key means allow all in current IntelliJ builds. pidea deny-lists every `xdebug_*` name. Set `PIDEA_IDE_EXTRA_TOOLS` to a comma-separated list of remote names to re-allow tools you reviewed.

Air's IDE server (`jetbrains_air_ide`) offers its tools through one router tool, `execute_tool`, which takes a command line such as `lint_files --files '["src/app.py"]'`. pi gets the router itself, because Air's skills call it by name. pidea checks each call's command name, the first word of `command`, against the same deny-list and rejects a denied one without contacting the IDE. `PIDEA_IDE_EXTRA_TOOLS` re-allows a command by that name.

The session catalog never changes. After you edit IntelliJ MCP settings or the allowlist, open a new chat. Debugger tools register only while an IDE debug session is live: start a debug session and open a new chat to see them.

A development profile with a conservative IDE tool subset:

```json
{
  "agent_servers": {
    "pidea": {
      "command": "/path/to/pidea/dist/index.js",
      "args": [],
      "env": {
        "PIDEA_PI_COMMAND": "/path/to/pi",
        "PIDEA_DEBUG_BRIDGE": "1"
      },
      "idea_mcp_allowed_tools": [
        "search_symbol",
        "get_symbol_info",
        "analyze_calls",
        "search_text",
        "search_regex",
        "get_file_problems",
        "lint_files",
        "build_project",
        "execute_run_configuration",
        "git_status",
        "get_repositories",
        "get_project_modules",
        "get_project_dependencies",
        "list_directory_tree",
        "read_file",
        "search_file",
        "open_file_in_editor",
        "get_all_open_file_paths",
        "skill_search"
      ]
    }
  }
}
```

### Post-turn inspection

After each turn, pidea runs IntelliJ's inspections on the files the turn changed (git status merged with the paths the turn's tools touched), plus the KTS scripts in [`inspections/`](inspections/README.md). Findings are summarized in the chat as `IDE inspection:` and written to `.pi/work/ide-inspections/<sessionId>/` in the project, or to `PIDEA_IDE_INSPECT_DIR`. `PIDEA_ENFORCE_IDE_INSPECT=0` turns it off.

## IntelliJ-first coding mode

`PIDEA_IDE_MODE` controls how the session uses IntelliJ for normal coding work. pi still generates every implementation; IntelliJ opens, reads, searches, applies, renames, reformats, and validates.

- `off` (default): IDE tools are exposed alongside pi's native tools; nothing is removed and no extra prompt guidance is added.
- `prefer`: removes the native `read`, `edit`, `write`, `grep`, `find`, and `ls` tools once the required IDE capabilities register. If the IDE bridge degrades, those tools come back and the session gets an explicit fallback notice.
- `required`: removes the same native tools immediately and keeps them removed if the IDE bridge is missing or loses connection. The session reports that the task is blocked until a new healthy chat starts.

Required capabilities: `read_file`, `open_file_in_editor`, `apply_patch`, `create_new_file`, one search tool, and one inspection tool. Tool names are discovered from the live catalog, never guessed.

In active modes, mutations run through IntelliJ and open the affected files: existing files open before `apply_patch`, created and moved files open after. Patch targets and path arguments are confined to the ACP project root; paths outside it are rejected, including symlink escapes. Structured path fields in search and inspection results are checked against the project root: in `prefer`, results naming files outside the root are diagnosed on the result; in `required`, they are rejected. Unstructured result text is passed through unchanged, because generic text scanning is not a safe discriminator.

Bash stays available in `prefer` for Git, tests, builds, and diagnostics. Unrestricted bash can still change files, so this mode is policy enforcement for normal coding tools, not a filesystem sandbox.

**Mutation provenance.** After each turn, the IDE bridge reports the paths that successful IDE mutation tools changed, and pidea compares them with the files changed during the turn. Files that changed without an IDE mutation are reported as `Mutation provenance` violations in the chat and recorded under `PromptResponse._meta.pidea.mutationViolations`. Deleted files and files committed mid-turn are not detected. `PIDEA_ENFORCE_IDE_MUTATIONS=0` turns this check off.

The File access setting is the protocol-standard way to route pi's read, edit, and write through the editor in any ACP client; IntelliJ-first mode goes further and replaces pi's native tools with IntelliJ's MCP tools.

## Environment variables

Set these for the adapter process, for example in the `env` of the agent entry in `~/.jetbrains/acp.json`.

| Variable                               | Effect                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIDEA_PI_COMMAND`                     | Path to the pi executable. Default: `pi`.                                                                                                           |
| `PIDEA_TOOL_APPROVAL=off\|edits\|all`  | Default tool approval for new sessions. Default: `off`.                                                                                             |
| `PIDEA_FILE_ACCESS=disk\|editor`       | Default file access for read, edit and write in new sessions, for clients with fs support. Default: `editor`.                                       |
| `PIDEA_IDE_MODE=off\|prefer\|required` | IntelliJ-first coding mode. Default: `off`.                                                                                                         |
| `PIDEA_ENFORCE_IDE_INSPECT=0`          | Turn off the post-turn inspection.                                                                                                                  |
| `PIDEA_IDE_INSPECT_DIR`                | Write inspection reports here instead of into the project.                                                                                          |
| `PIDEA_ENFORCE_IDE_MUTATIONS=0`        | Turn off the mutation provenance check.                                                                                                             |
| `PIDEA_IDE_EXTRA_TOOLS`                | Re-allow deny-listed IDE tools. Comma-separated remote names.                                                                                       |
| `PIDEA_UPDATE_CHECK=0`                 | Turn off the update notice.                                                                                                                         |
| `PIDEA_SESSION_MAP`                    | Session map path. Default: `~/.pi/pidea/session-map.json`.                                                                                          |
| `PIDEA_ENABLE_EMBEDDED_CONTEXT=true`   | Advertise `embeddedContext` support.                                                                                                                |
| `PIDEA_DEBUG_ACP=1` or a file path     | Log incoming ACP requests and outgoing errors to `~/.pi/pidea/acp-debug.log` (or the given file). Prompt text, images, env and headers are omitted. |
| `PIDEA_DEBUG_BRIDGE=1`                 | Log the sanitized `session/new` MCP descriptor to stderr. IntelliJ writes that stderr into `idea.log`.                                              |

pidea sets `PIDEA_CLIENT_HINTS`, `PIDEA_MCP_IPC_ENDPOINT`, `PIDEA_MCP_IPC_TOKEN` and `PIDEA_MCP_SESSION_ID` itself for the pi subprocess; don't set them.

## Authentication

pidea advertises terminal auth metadata. ACP clients can start interactive provider login from their auth UI, or you run it yourself:

```bash
pidea --terminal-login
```

## Protocol coverage gaps

- Terminals: pidea does not delegate shell commands to the client (IntelliJ declares no terminal support). pi runs commands locally.
- File access through the editor covers read, edit, and write only; search tools and shell commands use the disk.
- `providers/set` and `providers/disable` return a method-not-found error. pi configures providers outside the RPC surface.
- No plan updates: pi has no plan concept.
- No `logout` and no additional workspace roots: pi's RPC surface has neither.
- The IDE bridge speaks the MCP-over-ACP protocol generation with `mcp/connect`. ACP SDK 1.x defines a newer, stateless one; current IntelliJ builds accept the older form.
- Tool approval covers tool calls pi makes. Calls one tool makes on behalf of another (pi's optional codemode) carry ids the client never sees as tool calls, so their approval prompt is not attached to a visible call.
