# pi-confirm

A confirmation extension for [pi](https://github.com/earendil-works/pi) that asks before any tool call can edit or write files on the filesystem or run shell commands.

`pi-confirm` intercepts the `bash`, `powershell`, `write` and `edit` tools and checks every call against user-defined rules. Matching calls either run silently, trigger a confirmation dialog, or are blocked outright. This makes pi safer to use with powerful models: destructive commands and sensitive files never touch the disk without an explicit yes.

## How it works

| Tool | Guarded by | Behavior |
|------|------------|----------|
| `bash` | `confirm-commands` | The command line is parsed with [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) and **every distinct program it invokes** (e.g. `grep` in `ls && grep foo bar`) is checked separately. |
| `powershell` | `confirm-commands` | The whole command (and its first word) is checked. |
| `write` | `confirm-files` | The file path is checked (creates or overwrites a file). |
| `edit` | `confirm-files` | The file path is checked (modifies a file). |

### Actions

Each setting maps a pattern to one of three actions:

- `allow` — the matching call runs without any confirmation
- `ask` — the user is asked for confirmation (**the default when no pattern matches**)
- `deny` — the matching call is always blocked

When several patterns of the same layer match, the **strictest action wins** (`deny` > `ask` > `allow`).

### Pattern matching

Patterns use glob syntax (via minimatch with `dot: true`).

`confirm-files` patterns are matched against the file path used in the tool call — its absolute form, its form relative to the current working directory, and its basename:

```json
{
  "confirm-files": {
    "*.go": "ask",
    "secrets/**": "deny",
    "/abs/path/or/relative/file": "allow"
  }
}
```

- `*.go` matches any Go file
- `src/**` matches everything under `src/` of the project

`confirm-commands` patterns are matched against the program name (basename of the invoked program), the first word of the command line, and the whole (whitespace-normalized) command line:

```json
{
  "confirm-commands": {
    "rm": "deny",
    "git": "allow",
    "sudo*": "deny"
  }
}
```

- `rm` denies any `rm` invocation
- `git push*` matches whole command lines starting with `git push`

### Smart bash analysis

For `bash` commands, the extension parses the full command line with tree-sitter and analyzes every simple command — including those inside subshells, pipelines, loops, command substitutions and process substitutions.

**Wrapper commands** such as `sudo`, `xargs`, `nohup`, `env CMD ...`, shells (`bash`, `sh`, `python`, `node`, ...) and `eval` can execute an arbitrary program hidden in their arguments. When one of these occurs anywhere in the line (or the line cannot be parsed / a program cannot be identified statically), the **whole command is checked as a single unit** and remembering is not offered.

### Confirmation dialog

When an action is `ask` and an interactive UI is available, a dialog offers up to three choices:

- **Allow once** — permit just this single tool call
- **Allow ... for this session** — remember the exact file path (`write`/`edit`), program name (`bash`) or whole command (`powershell`) as a session override with action `allow`
- **Deny** — block the tool call

In non-interactive mode (no UI, e.g. `pi -p`), guarded calls resolve to their configured action: `allow` runs, while `ask` and `deny` block.

## Settings layers

Settings have two layers:

1. **Session overrides**, set at runtime with the commands below. They apply to the current session only, take precedence over the configuration file, and are cleared when the session ends, is replaced (`/new`, `/resume`, `/fork`), or pi is restarted.
2. **Permanent settings** in pi's configuration file. The project settings (`.pi/settings.json`, honored only when the project is trusted) override the global settings (`~/.pi/agent/settings.json`) key by key.

Example `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "confirm-files": {
    "*.go": "ask",
    "secrets/**": "deny",
    "/abs/path/or/relative/file": "allow"
  },
  "confirm-commands": {
    "rm": "deny",
    "git": "allow",
    "sudo*": "deny"
  }
}
```

## Commands

Both `/confirm-files` and `/confirm-commands` accept the same sub-forms (shown here for `/confirm-files`):

| Command | Effect |
|---------|--------|
| `/confirm-files` | Show the effective settings |
| `/confirm-files <pattern> <action>` | Set a session override (action: `allow` \| `ask` \| `deny`) |
| `/confirm-files remove <pattern>` | Remove a session override |
| `/confirm-files clear` | Clear all session overrides |
| `/confirm-files <pattern> <action> --project` | Write the rule to `.pi/settings.json` |
| `/confirm-files <pattern> <action> --global` | Write the rule to `~/.pi/agent/settings.json` |
| `/confirm-files remove <pattern> --project` / `--global` | Remove the rule from a permanent settings file |

## Installation

`pi-confirm` is a TypeScript extension loaded directly by pi (via jiti, no build step required).

### As a user extension (all projects)

Copy the extension (including its `package.json`) into pi's user extensions directory:

```bash
git clone https://github.com/simo-tuomisto/pi-confirm.git ~/.pi/agent/extensions/pi-confirm
```

### As a project extension (single project)

Place it in the project's `.pi/extensions/` directory:

```bash
git clone https://github.com/simo-tuomisto/pi-confirm.git .pi/extensions/pi-confirm
```

### During development

Load a file directly:

```bash
pi --extension ./index.ts
```

Install the npm dependencies (tree-sitter, tree-sitter-bash, minimatch):

```bash
npm install
```

> **Note:** Project extensions are only loaded when the project is trusted.

## Security model

- The extension runs inside the pi process with your OS permissions. It only *adds* friction — everything is `ask` by default, so nothing runs or writes without your consent unless you explicitly `allow` it.
- "Remember" options are always session-scoped and never persisted to disk.
- Wrapper commands that can hide the actual program being run (`sudo`, `sh -c`, `python script.py`, ...) are deliberately treated as opaque: they are confirmed as a whole and can never be remembered for the session.
- Project-level settings are only honored for trusted projects, so a cloned repository cannot silently whitelist its own dangerous commands.

## AI usage

This project was created with AI. Idea to use [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and other design decisions were made by human.

## License

[MIT](LICENSE) © 2026 Simo Tuomisto
