# OpenOrcha

OpenOrcha is a local-first Express UI and API for launching, monitoring, and coordinating coding agents from your machine. It also includes tabs for terminal sessions, SSH config, SSH keys, known hosts, presets, and agent context.

## Why Use OpenOrcha

OpenOrcha makes multi-agent work easier to manage. Instead of juggling terminal windows, session names, and half-visible output, it gives you a single place to launch agents, inspect what they are doing, and keep parallel workstreams organized.

- Keeps agent work organized across projects, sessions, and presets
- Provides a clean interface for launching, monitoring, and resuming agent runs
- Reduces friction with an intuitive workflow around terminals, context, and follow-up input
- Makes parallel work practical by letting you coordinate multiple agents without losing track of state
- Brings SSH, session management, agent context, and git visibility into one local tool

## What It Does

- Launch agent CLIs inside `tmux`
- Read agent output and send follow-up messages
- Resume supported agent sessions
- Inspect agent context and git state for the current project
- Manage SSH config, keys, and `known_hosts`
- Browse terminal, `tmux`, and optional `screen` sessions

## Requirements

### Core requirements

- `node` and `npm`
- `tmux`
- At least one supported agent CLI on your `PATH`: `claude`, `codex`, `gemini`, `opencode`, or `aider`

Recommended Node version: `18+`

## System Dependencies

OpenOrcha shells out to local system tools. Some are required, some only power specific tabs or actions.

### Required for the main agent workflow

- `tmux`
  Used to launch agents, capture terminal output, and send input back into running sessions.
- A login shell such as `bash`, `zsh`, or `sh`
  Agent sessions are started in your shell so your normal `PATH` and shell config are loaded.

### Optional but strongly recommended

- `git`
  Powers the drawer Git view and repository status inspection.
- `ssh` and `ssh-keygen`
  Needed for SSH session helpers, key generation, and `known_hosts` cleanup.
- `screen`
  Enables the GNU screen session views and screen-backed agent/session interaction.

### Platform-specific dependencies

- `osascript` on macOS
  Used for terminal app discovery, focusing Terminal/iTerm2/Warp, and some terminal-session helpers.

### Standard Unix tools assumed to exist

These are used internally and are normally already available on macOS and most Linux systems:

- `ps`
- `pgrep`
- `kill`
- `lsof`

## Platform Notes

- The core web app and `tmux` agent workflow are Unix-oriented.
- Terminal discovery and focus features are macOS-first because they rely on AppleScript via `osascript`.
- If an optional dependency is missing, the related tab or action may be limited, but the rest of the app can still work.

## Quick Start

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3456`.

`npm start` runs the local server with `nodemon`, so code changes reload automatically during development.

## Verify Your Setup

This checks the most important commands:

```bash
command -v node npm tmux git ssh ssh-keygen screen
```

On macOS, you can also check:

```bash
command -v osascript
```

For agent launching, also verify the CLI you plan to use is installed:

```bash
command -v claude
command -v codex
command -v gemini
command -v opencode
command -v aider
```
