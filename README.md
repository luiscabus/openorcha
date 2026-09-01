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
- Run **supervised initiatives**: long work an agent carries through on its own

## Initiatives

An initiative is a piece of work that outlives the agent running it. You describe
the goal, point it at a directory, press Start, and a supervisor in the server
keeps the agent moving so you are not the thing standing between it and progress.

On each tick the supervisor looks at the agent and decides what to do — rules
first, a short LLM judgement call only when no rule fits:

- **Permission prompts** matching the initiative's autonomy profile are approved
  automatically. Anything outward-facing or destructive is never auto-approved.
- **Offers** ("Want me to run the tests?") get answered instead of waited on —
  the agent is told to take the reversible option and note the assumption.
- **"Done" claims are verified**, not believed: each stage has a check the
  supervisor runs itself (`git status`, commits ahead, a PR exists, or your own
  verify command). A claim that fails its check is pushed back.
- **Failures** get one self-repair attempt before they cost you anything.
- **Real decisions** — irreversible, outward-facing, or product judgement — are
  parked as a gate with the question and its context, and the supervisor moves
  on to another initiative instead of idling. You get a macOS notification, and
  a low-stakes gate with a safe default is taken automatically if you don't
  answer within the initiative's timeout.

### Autonomy profiles

| Profile | Automatic | Always a gate |
|---|---|---|
| `conservative` | read, edit, run tests | every commit |
| `standard` | the above, plus branches and commits | anything leaving the machine |
| `ship` | the above, plus `git push` and draft PRs | non-draft PRs, PR comments, Jira writes, merges, force pushes, pushes to master |

### Stages

The default pipeline follows the usual shape of this work: **Plan → Branch →
Implement → Verify → Commit → Push & draft PR**. Each stage carries its own
instruction, check and nudge budget, and the run advances only when the check
passes.

### Working in parallel

The supervisor runs work on two axes at once.

**Across initiatives** — every initiative has its own workers, and lanes are
ticked concurrently. A lane waiting at a gate never holds up the others, and a
judgement call is made off the tick, so a slow decision in one lane cannot
freeze the rest.

**Inside one initiative** — press *Split stage* and a stage fans out into
parallel tasks, one agent each. Each parallel worker gets **its own git
worktree and branch**, because two agents in one working tree fight over the
branch and the index. The stage completes only when every task's check passes,
and the branches are then handed to the next stage to merge.

Fan-out is bounded twice over: `maxParallel` per initiative (default 3) and
`OPENORCHA_MAX_AGENTS` across the machine (default 6). Workers start one per
tick so a ramp-up never blocks the server, a worker that dies is restarted
twice before it becomes your problem, and writing history while sitting on
`master` is refused whatever the profile says.

Finished worktrees are never removed behind your back. `POST
/api/initiatives/:id/worktrees/prune` removes only the ones whose worker is
done and whose tree is clean; the branch always survives.

### Where to look

- **AI Agents → Initiatives** — create initiatives, watch stages advance, answer
  gates, and read the digest of what moved while you were away.
- **AI Agents** — supervised initiatives appear as lanes alongside your ad-hoc
  ones, showing run state and any decision waiting on you.

Initiatives are stored as JSON under `data/initiatives/` and are not tracked by git.

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
