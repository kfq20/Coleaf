import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";
import type { Session } from "./types.js";

const WORKSPACES_ROOT = path.resolve(process.cwd(), "../workspaces");
const SESSION_FILE = ".coleaf-session.json";

// In-memory session store, mirrored to disk so that server restarts don't
// force users to re-clone.
const sessions = new Map<string, Session>();

export async function saveSession(session: Session): Promise<void> {
  const filepath = path.join(session.workspaceDir, SESSION_FILE);
  // Persist credentials + conversation history. Tokens are written in the
  // clear — same trust model as the workspace itself (single-user host).
  await fs.writeFile(filepath, JSON.stringify(session, null, 2), "utf-8");
}

export async function loadSessionsFromDisk(): Promise<number> {
  let count = 0;
  try {
    await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
    const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const filepath = path.join(WORKSPACES_ROOT, e.name, SESSION_FILE);
      try {
        const raw = await fs.readFile(filepath, "utf-8");
        const data = JSON.parse(raw) as Session;
        if (existsSync(data.workspaceDir)) {
          // Older files may be missing some array fields
          if (!Array.isArray(data.agentMessages)) data.agentMessages = [];
          if (!Array.isArray(data.responseHistory)) data.responseHistory = [];
          sessions.set(data.id, data);
          count++;
        }
      } catch {
        // Missing or malformed session file — leave the dir alone, skip it
      }
    }
  } catch {
    // Workspaces root not creatable — surface the error at first session create
  }
  return count;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return Array.from(sessions.values());
}

function buildAuthedGitUrl(rawUrl: string, token: string): string {
  // Overleaf uses https://git@git.overleaf.com/<id>
  // We need to inject the token: https://git:<token>@git.overleaf.com/<id>
  const url = new URL(rawUrl);
  url.username = "git";
  url.password = token;
  return url.toString();
}

async function findOrphanWorkspace(endpoint: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(WORKSPACES_ROOT, e.name);
      // Skip workspaces already associated with a live in-memory session
      if (Array.from(sessions.values()).some((s) => s.workspaceDir === dir)) continue;
      try {
        const remotes = await simpleGit(dir).getRemotes(true);
        const origin = remotes.find((r) => r.name === "origin");
        if (origin && gitEndpoint(origin.refs.fetch) === endpoint) {
          return dir;
        }
      } catch {
        // not a git repo, or no remotes — skip
      }
    }
  } catch {
    // workspaces dir missing
  }
  return null;
}

function gitEndpoint(url: string): string {
  // Strip auth so we can compare two URLs that point at the same project
  // even if the tokens differ.
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function createSession(input: {
  displayName: string;
  gitUrl: string;
  gitToken: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  model?: string;
}): Promise<Session> {
  const authedUrl = buildAuthedGitUrl(input.gitUrl, input.gitToken);
  const endpoint = gitEndpoint(authedUrl);

  // Reuse an existing workspace if the same person already has one for this
  // Overleaf project. Avoids re-cloning when localStorage was cleared or the
  // user logs in from a fresh browser.
  for (const existing of sessions.values()) {
    if (
      gitEndpoint(existing.gitUrl) === endpoint &&
      existing.displayName === input.displayName
    ) {
      // Refresh credentials (token may have changed since last login)
      existing.anthropicBaseUrl = input.anthropicBaseUrl;
      existing.anthropicAuthToken = input.anthropicAuthToken;
      existing.gitUrl = authedUrl;
      if (input.model) existing.model = input.model;
      try {
        await simpleGit(existing.workspaceDir).remote(["set-url", "origin", authedUrl]);
      } catch (err) {
        console.error("remote set-url failed", err);
      }
      await saveSession(existing);
      return existing;
    }
  }

  // Orphan-workspace recovery: scan disk for an existing clone of the same
  // Overleaf project that lost its session file (e.g. server restarted before
  // we added persistence). Adopt it instead of cloning again.
  const orphanDir = await findOrphanWorkspace(endpoint);
  let id: string;
  let workspaceDir: string;
  if (orphanDir) {
    id = path.basename(orphanDir);
    workspaceDir = orphanDir;
    try {
      await simpleGit(workspaceDir).remote(["set-url", "origin", authedUrl]);
    } catch (err) {
      console.error("remote set-url on orphan failed", err);
    }
  } else {
    id = randomBytes(12).toString("hex");
    workspaceDir = path.join(WORKSPACES_ROOT, id);
    await fs.mkdir(workspaceDir, { recursive: true });
    // Clone the repo
    const git = simpleGit();
    await git.clone(authedUrl, workspaceDir);
  }

  // Configure user identity for commits
  const repoGit = simpleGit(workspaceDir);
  await repoGit.addConfig("user.name", input.displayName, false, "local");
  await repoGit.addConfig(
    "user.email",
    `${input.displayName.replace(/\s+/g, ".").toLowerCase()}@coleaf.local`,
    false,
    "local",
  );

  const session: Session = {
    id,
    displayName: input.displayName,
    workspaceDir,
    gitUrl: authedUrl,
    anthropicBaseUrl: input.anthropicBaseUrl,
    anthropicAuthToken: input.anthropicAuthToken,
    model: input.model ?? "gpt-5.5",
    createdAt: Date.now(),
    agentMessages: [],
    responseHistory: [],
  };

  sessions.set(id, session);
  await saveSession(session);
  return session;
}

export async function deleteSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  await fs.rm(session.workspaceDir, { recursive: true, force: true });
  return true;
}
