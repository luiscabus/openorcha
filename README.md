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

### Defining done before the work starts

A run is only as autonomous as its definition of done. With nothing to check
against, the supervisor falls back on judgement calls and gates — which is the
very thing that pulls you back in. So an initiative can carry **acceptance
criteria**, each with the check that settles it:

```
✓ The autosave test suite passes            npm test
✓ Findings cover the risks and open questions   docs/findings.md contains "Risks", "Open questions"
· The branch is pushed                      branch is pushed
· Each item exists as a real Jira ticket     your call
```

Press **Work out what done means** when creating an initiative and one pass
reads the project and proposes them, along with the open questions worth
settling first — the ones whose answers would change what "done" means. It
takes about a minute, runs without tools (the project context it needs is in
the prompt), and everything it proposes is editable before you accept it.

Criteria that no machine can settle are marked as needing you, rather than
dressed up as automatic. At the end of the run the supervisor measures rather
than asks: unmet checkable criteria send the agent back to close the gap, and
only the human ones become a single sign-off.

### Stopping and removing

- **Pause** — stop supervising, leave the agents running so you can take one
  over by hand.
- **Stop** — end the run and kill the agent sessions it started. Commits,
  branches and worktrees are untouched.
- **Remove** — delete the initiative record. Its agents are killed, commits and
  branches always survive, and worktrees are only removed if you ask and only
  when they are clean.

Set `OPENORCHA_NO_LAUNCH=1` to stop the supervisor starting agents at all —
what the test suite uses, and useful for a dry run.

### Templates — picking the right shape

The stage pipeline is not one shape. Sessions in this workflow fall into a few
recognisable kinds, and each wants different stages, a different autonomy
profile, and a different place to fan out:

| Template | For | Autonomy | Fans out on |
|---|---|---|---|
| **PR review** | Reviewing a PR, or working the comments on your own | `ship` | one agent per PR |
| **Spec review → tickets** | Validating a plan against the code, then slicing it | `standard` | one agent per repo/area |
| **Ticket → PR** | Building understood work and shipping it | `ship` | one agent per independent piece |
| **PoC / spike** | Answering "is this feasible" | `standard` | one agent per approach |
| **Discovery** | Understanding how something works, no code changes | `conservative` | one agent per subsystem |

Templates live in `data/initiative-templates/` as JSON — edit them, or drop in
your own; they show up in the New Initiative picker automatically. `Ticket → PR`
is also the built-in default pipeline, so there is one definition of it.

### When *not* to make an initiative

Most sessions should stay plain `claude` sessions. An initiative is worth the
setup when the work has a definition of done and will outlive your attention —
it needs stages, gates, and someone to keep it moving while you are away. A
question, a broken container, an env fix, or a five-minute change does not:
just launch an agent from the AI Agents tab and talk to it.

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
