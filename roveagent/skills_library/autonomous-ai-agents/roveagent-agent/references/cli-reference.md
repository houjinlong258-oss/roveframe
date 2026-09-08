# RoveAgent CLI Reference

Live sources when anything looks stale: `roveagent --help`, `roveagent <command> --help`,
https://roveagent-agent.nousresearch.com/docs/reference/cli-commands

### Global Flags

```
roveagent [flags] [command]        (no subcommand = interactive chat)

  --version, -V             Show version
  -z, --oneshot PROMPT      One-shot: print ONLY the final response (for scripts/pipes)
  -m MODEL  --provider P    Model/provider override for this invocation
  -t, --toolsets LIST       Comma-separated toolsets for this invocation
  --resume, -r SESSION      Resume session by ID or title
  --continue, -c [NAME]     Resume by name, or most recent session
  --worktree, -w            Isolated git worktree mode (parallel agents)
  --skills, -s SKILL        Preload skills (comma-separate or repeat)
  --profile, -p NAME        Use a named profile
  --yolo                    Skip dangerous command approval
  --tui / --cli             Force the Ink TUI / classic REPL
  --ignore-rules            Skip AGENTS.md/SOUL.md/memory/skill injection
  --safe-mode               Disable ALL customizations (troubleshooting)
  --pass-session-id         Include session ID in system prompt
```

### Chat

```
roveagent chat [flags]
  -q, --query TEXT          Single query, non-interactive
  --image PATH              Attach a local image to a single query
  -Q, --quiet               Suppress banner, spinner, tool previews
  --checkpoints             Enable filesystem checkpoints (/rollback)
  --max-turns N             Cap tool-calling iterations
  --source TAG              Session source tag (default: cli)
```
(plus the global flags above)

### Configuration

```
roveagent setup [section]      Wizard (model|tts|terminal|gateway|tools|agent)
roveagent model                Interactive model/provider picker
roveagent fallback [add|remove|list]  Fallback provider chain
roveagent config [show|edit|get|set|unset|path|env-path|check|migrate]
roveagent login / logout       OAuth sign-in / clear stored auth
roveagent doctor [--fix]       Check dependencies and config
roveagent status [--all]       Component status
```

### Tools & Skills

```
roveagent tools [list|enable NAME|disable NAME]   Per-platform toolsets (curses UI with no args)

roveagent skills list|browse|search QUERY|inspect ID
roveagent skills install ID    Hub identifier OR a direct https://…/SKILL.md URL
roveagent skills config        Enable/disable skills per platform
roveagent skills check|update|uninstall|publish PATH
roveagent skills tap add REPO  Add a GitHub repo as a skill source
roveagent bundles              Skill bundles (one /<name> alias loads several skills)
```

### MCP Servers

```
roveagent mcp add NAME (--url or --command) | remove | list | test NAME
roveagent mcp catalog | install NAME     Curated catalog install
roveagent mcp configure NAME             Toggle tool selection
roveagent mcp serve                      Run RoveAgent as an MCP server
```
Details (transport, tool discovery, catalog): `references/native-mcp.md`.

### Gateway (Messaging Platforms)

```
roveagent gateway run|install|start|stop|restart|status|setup
```

20+ platforms: Telegram, Discord, Slack, WhatsApp (Baileys + Business Cloud API), iMessage (Photon — `roveagent photon setup`), Signal, Email, SMS, Matrix, Mattermost, Teams, LINE, SimpleX, ntfy, Google Chat, Home Assistant, DingTalk, Feishu, WeCom, Weixin, API Server, Webhooks. Open WebUI connects via the API Server adapter. Most adapters ship under `plugins/platforms/`.
Docs: https://roveagent-agent.nousresearch.com/docs/user-guide/messaging/

### Sessions

```
roveagent sessions list|browse|rename ID TITLE|delete ID|export OUT|prune|stats
```

### Cron / Webhooks

```
roveagent cron list|create SCHED|edit ID|pause|resume|run ID|remove|status
    Schedules: '30m', 'every 2h', '0 9 * * *', ISO timestamp
roveagent webhook subscribe NAME|list|remove NAME|test NAME
```
Webhook payloads/routes: `references/webhooks.md`.

### Profiles

```
roveagent profile list|create NAME (--clone|--clone-all|--clone-from)|use|show|delete
roveagent profile rename A B | alias NAME | export NAME | import FILE
```

### Credentials & Pools

```
roveagent auth                 Interactive credential manager
roveagent auth add [PROVIDER]  Add OAuth or API-key credential (nous, openai-codex, qwen-oauth, …)
roveagent auth list|remove P IDX|reset PROVIDER|status
```
Multiple credentials per provider form a pool that rotates automatically and skips exhausted keys.

### Other

```
roveagent desktop / gui        Native desktop app
roveagent dashboard            Web admin panel + embedded chat (--stop / --status)
roveagent proxy                OpenAI-compatible local proxy backed by an OAuth provider
roveagent portal               Quick setup / sign in via Nous Portal
roveagent kanban <verb>        Multi-agent work-queue board
roveagent project              Named multi-folder workspaces
roveagent skin list|use|set    Switch/tweak skins (see references/themes.md)
roveagent pets <verb>          Pet mascots (see references/petdex.md)
roveagent memory setup|status|off|reset   Memory provider
roveagent secrets bitwarden|onepassword   External secret stores
roveagent moa                  Mixture-of-Agents slots
roveagent hooks / security / backup / import / checkpoints / console
roveagent logs [-f] [errors]   View agent/error logs
roveagent send                 One-off message through a gateway platform
roveagent pairing / plugins / insights / journey / computer-use
roveagent acp                  ACP server (IDE integration)
roveagent completion bash|zsh|fish
roveagent update / uninstall / claw migrate
```

Plugin- and provider-supplied subcommands (e.g. `roveagent photon setup`) only appear once their plugin is installed/active.

### Where to Find Things

| Looking for... | Location |
|---|---|
| Config options | `roveagent config edit` · [Configuration docs](https://roveagent-agent.nousresearch.com/docs/user-guide/configuration) |
| Tools / toolsets | `roveagent tools list` · [Tools reference](https://roveagent-agent.nousresearch.com/docs/reference/tools-reference) |
| Skills catalog | `roveagent skills browse` · [Skills catalog](https://roveagent-agent.nousresearch.com/docs/reference/skills-catalog) |
| Provider setup | `roveagent model` · [Providers guide](https://roveagent-agent.nousresearch.com/docs/integrations/providers) |
| Env variables | `roveagent config env-path` · [Env vars reference](https://roveagent-agent.nousresearch.com/docs/reference/environment-variables) |
| Gateway logs | `~/.roveagent/logs/gateway.log` (or `roveagent logs`) |
| Sessions | `roveagent sessions browse` (reads state.db) |
