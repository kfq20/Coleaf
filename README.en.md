# Coleaf

English | [中文](./README.md)

Turn any Overleaf Git project into a **multi-user AI workspace for collaborative LaTeX writing**.

Coleaf is a local-first web app that connects to an Overleaf Git repository and gives you a Monaco editor, PDF preview, Git sync controls, and an agent chat panel that can read and edit files in your paper project. Each collaborator brings their own model credentials and Overleaf token.

![Coleaf screenshot](./docs/screenshot.png)

## Why Coleaf?

Overleaf is great for collaborative LaTeX editing. Coding agents are great at structured edits, rewriting, fixing references, and reorganizing sections. But wiring an agent directly into a shared paper project raises a few practical problems:

- The agent does not know the full project structure.
- Edits often span multiple `.tex`, `.bib`, and `.sty` files.
- When multiple collaborators use agents, it is hard to control who syncs what back to Overleaf.
- Letting an agent push directly is too risky; a human should make the final call.

Coleaf's idea is simple: **do not replace Overleaf; add an AI workspace next to Overleaf Git**.

## Features

- **Connect to Overleaf Git projects**: every session gets its own isolated workspace clone.
- **Overleaf-like editing experience**: file tree, Monaco editor, and autosave.
- **PDF preview**: the backend compiles with `latexmk` and serves the PDF to the browser.
- **Agent chat for paper edits**: the agent can list files, read files, perform exact replacements, write files, inspect Git status, and create local commits.
- **Human-controlled sync**: the agent never pushes; users click `Sync to Overleaf` to pull/rebase/push.
- **Collaboration-friendly Git flow**: multiple users sync through Git, and conflicts are surfaced in the UI for manual resolution.
- **Bring your own model credentials**: supports OpenAI-compatible Responses API endpoints; no platform-level global API key is required.

## Quick Start

```bash
git clone https://github.com/<your-name>/coleaf.git
cd coleaf
npm install
npm run install:all
npm run dev
```

After startup:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## What Do I Need To Log In?

The login page asks for:

| Field | Description |
| --- | --- |
| Display name | Used as the local Git commit author name |
| Overleaf Git URL | For example `https://git.overleaf.com/<project-id>` |
| Overleaf Git token | Create one in Overleaf Account Settings |
| Base URL | OpenAI-compatible Responses API endpoint |
| Auth token | API token for your model provider |
| Model | Model name, for example `gpt-5.5`, `gpt-5`, `gpt-4o`, etc. |

> Note: a few internal field names still use legacy `anthropic*` naming, but the current agent path uses the OpenAI-compatible Responses API.

## What Can The Agent Do?

The agent currently has 6 tools, all scoped to the current session workspace:

| Tool | Capability |
| --- | --- |
| `list_files` | Inspect the project file tree |
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Replace one unique string occurrence exactly |
| `git_status` | Inspect modified, untracked, ahead, and behind state |
| `git_commit` | Stage all changes and create a local commit |

The agent **does not push automatically**. Syncing back to Overleaf must be triggered by the user through `Sync to Overleaf`.

## Sync Flow

When you click `Sync to Overleaf`, the backend will:

1. Commit any pending local edits.
2. Run `git pull --rebase origin` to pull collaborator changes.
3. Run `git push origin` if there are local commits.
4. If rebase conflicts occur, surface the conflicted files in the UI and let the user resolve them manually.

## Architecture

```text
┌──────────────────── Browser ────────────────────┐
│  React + Monaco + PDF Preview + Chat Panel      │
└────────────────────────┬────────────────────────┘
                         │ HTTP + SSE
┌────────────────────────▼────────────────────────┐
│  Express + TypeScript server                    │
│  ├── /api/sessions        session management    │
│  ├── /api/.../files       tree / read / write    │
│  ├── /api/.../git/*       status / sync / rebase │
│  ├── /api/.../compile     latexmk compilation    │
│  └── /api/.../agent       streaming SSE agent    │
│       └── OpenAI-compatible Responses API        │
│           + file/git tools                       │
│                                                │
│  Per-session workdir: ./workspaces/<id>/        │
└────────────────────────┬────────────────────────┘
                         │ git pull / push
                         ▼
                  git.overleaf.com
```

## Project Layout

```text
coleaf/
├── server/                 Express + TypeScript backend
│   └── src/
│       ├── index.ts        HTTP routes
│       ├── sessions.ts     session persistence and Overleaf clone
│       ├── files.ts        workspace-scoped file operations
│       ├── git.ts          status / commit / sync / conflict
│       ├── compile.ts      latexmk compilation and PDF output
│       └── agent.ts        Responses API streaming agent loop
├── web/                    Vite + React + Monaco frontend
│   └── src/
│       ├── api.ts          HTTP + SSE client
│       ├── pages/Editor.tsx
│       └── components/
│           ├── FileTree.tsx
│           ├── EditorPane.tsx
│           ├── PdfPane.tsx
│           └── ChatPanel.tsx
├── docs/
│   └── screenshot.png
└── workspaces/             Local session clones, gitignored by default
```

## Security Model

Coleaf is currently an MVP. It is better suited for local or trusted deployments and should not be exposed publicly without additional hardening.

Important limitations:

- `workspaces/<id>/.coleaf-session.json` stores session data and credentials in plaintext.
- Workspace Git remotes may contain embedded Overleaf tokens.
- The server has no built-in user authentication.
- The agent can modify any file inside the workspace.
- LaTeX compilation uses `latexmk -shell-escape`; do not compile untrusted projects.
- Multi-user isolation is directory-based, not container-sandboxed.

For production-style deployments, consider adding at least:

- Authentication and an authorization model.
- Per-session container isolation.
- Encrypted credential storage.
- Disabling or isolating `-shell-escape`.
- Agent tool-call auditing.
- Stricter `.git` directory protection.

## Development Scripts

```bash
# Install root dependencies
npm install

# Install frontend and backend dependencies
npm run install:all

# Start server and web together
npm run dev

# Start backend only
cd server && npm run dev

# Start frontend only
cd web && npm run dev

# Build checks
cd server && npm run build
cd web && npm run build
```

## Roadmap

- Diff review mode before agent edits are applied.
- Better conflict resolution UI.
- Multi-user presence and activity feed.
- Comment / suggestion mode instead of direct writes.
- Per-session containerized execution.
- OAuth / SSO / team permissions.
- Deployment templates and `.env` configuration.

## Community

Coleaf recognizes and appreciates the [LINUX DO](https://linux.do/) community. Feedback, suggestions, and contributions from LINUX DO members are welcome.

## License

MIT
