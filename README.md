# Calypso Multi-Agent

A local dev tool for running multiple isolated Claude Code agents against different branches of [wp-calypso](https://github.com/Automattic/wp-calypso) in parallel. Each branch gets its own git worktree, its own Docker sandbox running Claude Code, and its own Calypso dashboard, all orchestrated from a single web UI.

## What it does

- **Per-branch sandboxes** — each task you create gets a dedicated Docker sandbox (via `docker sandbox`) with Claude running inside. Agents can't see each other's worktrees or state.
- **Trunk branch** — a special, always-present row that runs Claude on the host (no sandbox) against your main Calypso checkout.
- **Shared Claude auth** — credentials from `~/.claude-sandbox/` are synced in/out of each sandbox so you log in once and every sandbox reuses the same Max/Pro OAuth token.
- **Dashboard reverse proxy** — `http://my.localhost:3000` always routes to whichever branch is currently marked active, so Calypso's hostname handling (cookies, CORS, session routing) keeps working no matter which branch you're viewing.
- **Open in Editor / Terminal / Claude** — launch the worktree in VS Code, open a login shell, or attach to the running Claude pty straight from the UI. The terminal panel supports a split layout with an animated fullscreen toggle via the browser View Transitions API.
- **Git branch merging** — lists all local git branches at startup, so branches you already have appear as "stubs". Clicking Start on a stub creates a worktree, sandbox, and Claude session for it on demand.
- **Base branch selection** — Create Branch modal lets you pick the base from any local git branch.

## Architecture

```
┌──────────────────────────────────────────────┐
│           Frontend (Vite, :9091)             │
│   React + Chakra UI v3 + xterm.js terminal   │
└───────┬──────────────────────────────────────┘
        │ /api/*, /api/branches/:id/terminal (ws)
┌───────▼──────────────────────────────────────┐
│        Backend (Fastify, :9090)              │
│                                               │
│  ┌─────────────┐  ┌──────────────────────┐   │
│  │ REST + WS   │  │ Branch proxy (:3000) │   │
│  │ /api/*      │  │ my.localhost →       │   │
│  │             │  │   active branch port │   │
│  └──────┬──────┘  └──────────┬───────────┘   │
│         │                    │               │
│  ┌──────▼────────┬───────────▼────────┐      │
│  │ state.json    │ shared ptys,       │      │
│  │ (.config/)    │ dashboards,        │      │
│  │               │ sandbox lifecycle  │      │
│  └───────────────┴────────────────────┘      │
└───────┬──────────────────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │                           │
┌──▼────────────────┐  ┌───────▼─────────────┐
│ Docker sandboxes  │  │ Host yarn processes │
│ (one per branch)  │  │ (yarn start-dashboard│
│ - claude pty      │  │  per branch, on     │
│ - worktree bind   │  │  shared pty)        │
│ - main repo bind  │  │                     │
│ - ~/.claude-      │  │                     │
│   sandbox bind    │  │                     │
└───────────────────┘  └─────────────────────┘
```

### Ports

| Port   | Service                                                     |
| ------ | ----------------------------------------------------------- |
| `9090` | Backend REST + WebSocket API                                |
| `9091` | Vite frontend                                               |
| `3000` | Branch proxy — `my.localhost:3000` → active branch dashboard|
| `4000` | Fallback proxy target (unused in practice)                  |
| `4001–4999` | Per-branch Calypso dashboard dev servers              |

### Directories (under the project root's `.config/`)

| Path                 | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `.config/state.json`                 | Persisted branches, active branch, settings        |
| `.config/repo/<repo>/<default>`      | Symlink to your local checkout (the repo's default branch, e.g. `trunk` or `main`) |
| `.config/repo/<repo>/<branch>`       | Per-branch git worktrees (siblings of the default) |
| `~/.claude-sandbox/`                 | Shared OAuth credentials injected into each sandbox|

## Getting started

Requires macOS (the folder picker uses `osascript`) with:

- Node 22+
- Docker Desktop with the `docker sandbox` plugin
- VS Code's `code` command on PATH (for Open in Editor)
- A local `wp-calypso` checkout

```bash
npm install
npm run dev
```

This launches both the backend (`:9090`) and frontend (`:9091`) via `npm-run-all`. Open <http://localhost:9091> and click **Settings** on first run to pick your repo folder — the tool symlinks it to `.config/repo/<repo_name>/<default_branch>` (no clone; `<repo_name>` is the basename of the picked folder, `<default_branch>` is detected from `origin/HEAD`) and starts trunk automatically. Per-branch worktrees land as siblings at `.config/repo/<repo_name>/<branch>`.

## Project layout

```
backend/
  src/
    index.ts        # Fastify bootstrap, branch proxy, trunk/sandbox rehydrate
    config.ts       # Paths, ports (resolved from project root)
    routes.ts       # REST API
    terminal.ts     # /api/branches/:id/terminal WebSocket
    state.ts        # state.json, branches, trunk seed
    docker.ts       # docker sandbox lifecycle, shared claude ptys
    dashboard.ts    # yarn start-dashboard lifecycle per worktree (via shared pty)
    sharedPty.ts    # keyed pty pool for trunk claude/bash and dashboards
    worktree.ts     # git worktree add/remove, list local branches
    shell.ts        # run / runOrThrow wrappers

frontend/
  src/
    App.tsx           # Branch table, Create modal, split layout
    TerminalModal.tsx # xterm panel + Claude/Terminal tabs
    SettingsModal.tsx # Choose folder + save
    Toaster.tsx       # Chakra v3 toaster host
    api.ts            # API types + fetch wrappers
    main.tsx          # ChakraProvider + next-themes dark mode
```

## Notable design decisions

- **Trunk runs on the host, not in a sandbox.** Gives immediate access to your real Claude config and avoids one extra layer for the main branch.
- **Dashboards run on the host, on a shared pty.** `docker sandbox` has no port publishing, so launching `yarn start-dashboard` inside the sandbox would be unreachable from the browser. Each branch's dev server spawns on the host with `PORT=<branch.port>` set, via the same shared-pty pool as trunk's Claude session — so you can attach to the live dev-server log by opening the terminal panel with `kind=dashboard`, and scrollback replays on reconnect.
- **State migration.** On boot the backend renames the legacy `tasks` field in `state.json` to `branches` and migrates IDs.
- **Shared Claude pty for trunk.** Opening the Claude tab multiple times attaches to the same running session via a 100 KB ring buffer, so scrollback and state persist across panel close/open.
- **View Transitions API for fullscreen.** The terminal panel uses `document.startViewTransition` + `viewTransitionName` to animate the modal-like fullscreen morph, with a CSS fallback for browsers that don't support it.
- **No clone.** Settings symlinks your existing calypso checkout instead of cloning, so you reuse your local `node_modules`, existing branches, and yarn caches.
