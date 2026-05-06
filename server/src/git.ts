import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";

export type GitStatusSummary = {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  not_added: string[];
  deleted: string[];
  staged: string[];
  conflicted: string[];
  rebasing: boolean;
};

export async function status(workspaceDir: string): Promise<GitStatusSummary> {
  const git = simpleGit(workspaceDir);
  const s = await git.status();
  return {
    branch: s.current ?? "",
    ahead: s.ahead,
    behind: s.behind,
    modified: s.modified,
    not_added: s.not_added,
    deleted: s.deleted,
    staged: s.staged,
    conflicted: s.conflicted,
    rebasing: await isRebasing(workspaceDir),
  };
}

export async function commitAll(
  workspaceDir: string,
  message: string,
): Promise<{ committed: boolean; hash?: string; message: string }> {
  const git = simpleGit(workspaceDir);
  const s = await git.status();
  const hasChanges =
    s.modified.length + s.not_added.length + s.deleted.length + s.created.length > 0;
  if (!hasChanges) return { committed: false, message: "nothing to commit" };
  await git.add(["-A"]);
  const result = await git.commit(message);
  return { committed: true, hash: result.commit, message };
}

export type SyncResult =
  | { status: "success"; pulled: number; pushed: number; message: string }
  | { status: "conflict"; files: string[]; message: string }
  | { status: "pull_failed"; message: string }
  | { status: "push_failed"; pulled: number; message: string };

async function isRebasing(workspaceDir: string): Promise<boolean> {
  const a = path.join(workspaceDir, ".git", "rebase-merge");
  const b = path.join(workspaceDir, ".git", "rebase-apply");
  return existsSync(a) || existsSync(b);
}

/**
 * Commit any pending edits, pull --rebase, then push if we have local commits.
 * On rebase conflict, returns the conflicted file list and leaves the repo in
 * the rebasing state so the user can resolve and call continueSync.
 */
export async function sync(
  workspaceDir: string,
  authorName: string,
): Promise<SyncResult> {
  const git = simpleGit(workspaceDir);

  // 1. Commit anything pending so it doesn't get nuked by rebase
  const commitResult = await commitAll(
    workspaceDir,
    `${authorName}: edits via Coleaf`,
  );

  // 2. Pull with rebase
  const before = await git.status();
  try {
    await git.pull("origin", undefined, { "--rebase": "true" });
  } catch (err: any) {
    // If we landed in a rebase, that's a conflict, not a fatal error
    if (await isRebasing(workspaceDir)) {
      const s = await git.status();
      return {
        status: "conflict",
        files: s.conflicted,
        message: `${s.conflicted.length} file(s) conflict — resolve them and click Continue, or Abort to roll back.`,
      };
    }
    return {
      status: "pull_failed",
      message: `pull failed: ${err.message ?? err}`,
    };
  }

  const pulled = before.behind;

  // 3. Push if we have local commits
  const after = await git.status();
  if (after.ahead > 0) {
    try {
      await git.push("origin");
      return {
        status: "success",
        pulled,
        pushed: after.ahead,
        message: `pulled ${pulled} · pushed ${after.ahead}${commitResult.committed ? " (incl. new commit)" : ""}`,
      };
    } catch (err: any) {
      return {
        status: "push_failed",
        pulled,
        message: `push failed: ${err.message ?? err}`,
      };
    }
  }

  return {
    status: "success",
    pulled,
    pushed: 0,
    message: pulled > 0 ? `pulled ${pulled} commit(s)` : "up to date",
  };
}

export async function abortSync(
  workspaceDir: string,
): Promise<{ aborted: boolean; message: string }> {
  if (!(await isRebasing(workspaceDir))) {
    return { aborted: false, message: "not in a rebase" };
  }
  const git = simpleGit(workspaceDir);
  try {
    await git.rebase(["--abort"]);
    return { aborted: true, message: "rebase aborted, repo restored" };
  } catch (err: any) {
    return { aborted: false, message: `abort failed: ${err.message ?? err}` };
  }
}

/**
 * Detect files that have been "resolved" but still contain conflict markers.
 * git happily commits these if you just `git add` them, which produces a
 * broken commit — guard against it.
 */
async function filesWithMarkers(
  workspaceDir: string,
  candidates: string[],
): Promise<string[]> {
  const offending: string[] = [];
  for (const f of candidates) {
    try {
      const content = await fs.readFile(path.join(workspaceDir, f), "utf-8");
      if (/^<{7} /m.test(content) || /^>{7} /m.test(content) || /^={7}$/m.test(content)) {
        offending.push(f);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return offending;
}

export async function continueSync(workspaceDir: string): Promise<SyncResult> {
  if (!(await isRebasing(workspaceDir))) {
    return { status: "pull_failed", message: "not in a rebase — nothing to continue" };
  }
  const git = simpleGit(workspaceDir);

  // Refuse to proceed if any conflicted file still has merge markers
  const status = await git.status();
  const stillBroken = await filesWithMarkers(workspaceDir, status.conflicted);
  if (stillBroken.length > 0) {
    return {
      status: "conflict",
      files: status.conflicted,
      message: `${stillBroken.length} file(s) still contain <<<<<<< / >>>>>>> markers: ${stillBroken.join(", ")}`,
    };
  }

  try {
    await git.add(["-A"]);
    // `-c core.editor=true` keeps rebase from invoking $EDITOR for the
    // implicit commit message, without tripping simple-git's GIT_EDITOR check.
    await git.raw(["-c", "core.editor=true", "rebase", "--continue"]);
  } catch (err: any) {
    if (await isRebasing(workspaceDir)) {
      const s = await git.status();
      // Real conflict: there are unmerged files
      if (s.conflicted.length > 0) {
        return {
          status: "conflict",
          files: s.conflicted,
          message: `another conflict: ${s.conflicted.length} file(s)`,
        };
      }
      // No conflicts but still rebasing — likely simple-git fluke. Try once more.
      try {
        await git.raw(["-c", "core.editor=true", "rebase", "--continue"]);
      } catch (err2: any) {
        return {
          status: "pull_failed",
          message: `rebase --continue failed (retry): ${err2.message ?? err2}`,
        };
      }
    } else {
      return {
        status: "pull_failed",
        message: `rebase --continue failed: ${err.message ?? err}`,
      };
    }
  }

  // Rebase finished — push
  const after = await git.status();
  if (after.ahead > 0) {
    try {
      await git.push("origin");
      return {
        status: "success",
        pulled: after.behind,
        pushed: after.ahead,
        message: `pushed ${after.ahead} commit(s) after resolving conflict`,
      };
    } catch (err: any) {
      return {
        status: "push_failed",
        pulled: after.behind,
        message: `push failed: ${err.message ?? err}`,
      };
    }
  }
  return {
    status: "success",
    pulled: 0,
    pushed: 0,
    message: "rebase complete, nothing to push",
  };
}

/**
 * Auto-resolve every conflicted file by picking one side wholesale, then
 * stage + continue rebase + push. During a `pull --rebase`, your local
 * commits are being replayed on top of the rebased-onto branch (origin),
 * so the git terminology is reversed:
 *   --ours    = origin (the side being rebased onto)
 *   --theirs  = your local commit (the one being replayed)
 * We expose this as the user-friendly `mine`/`remote` instead.
 */
export async function resolveConflictWith(
  workspaceDir: string,
  side: "mine" | "remote",
): Promise<SyncResult> {
  if (!(await isRebasing(workspaceDir))) {
    return { status: "pull_failed", message: "not in a rebase — nothing to resolve" };
  }
  const git = simpleGit(workspaceDir);
  const status = await git.status();
  if (status.conflicted.length === 0) {
    return { status: "pull_failed", message: "no conflicts to resolve" };
  }
  const flag = side === "mine" ? "--theirs" : "--ours";
  for (const f of status.conflicted) {
    try {
      await git.raw(["checkout", flag, "--", f]);
    } catch (err: any) {
      return {
        status: "conflict",
        files: status.conflicted,
        message: `failed to ${side === "mine" ? "keep your" : "take remote"} version of ${f}: ${err.message ?? err}`,
      };
    }
  }
  try {
    await git.add(["-A"]);
    await git.raw(["-c", "core.editor=true", "rebase", "--continue"]);
  } catch (err: any) {
    if (await isRebasing(workspaceDir)) {
      const s = await git.status();
      return {
        status: "conflict",
        files: s.conflicted,
        message: `another conflict after auto-resolving: ${s.conflicted.length} file(s)`,
      };
    }
    return {
      status: "pull_failed",
      message: `rebase --continue failed: ${err.message ?? err}`,
    };
  }
  const after = await git.status();
  const label = side === "mine" ? "your version" : "remote version";
  if (after.ahead > 0) {
    try {
      await git.push("origin");
      return {
        status: "success",
        pulled: after.behind,
        pushed: after.ahead,
        message: `auto-resolved with ${label}, pushed ${after.ahead} commit(s)`,
      };
    } catch (err: any) {
      return {
        status: "push_failed",
        pulled: after.behind,
        message: `push failed: ${err.message ?? err}`,
      };
    }
  }
  return {
    status: "success",
    pulled: 0,
    pushed: 0,
    message: `auto-resolved with ${label}, nothing to push`,
  };
}

export type IncomingCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
};

export async function incoming(
  workspaceDir: string,
): Promise<{ commits: IncomingCommit[]; message: string }> {
  const git = simpleGit(workspaceDir);
  try {
    await git.fetch("origin");
  } catch (err: any) {
    return { commits: [], message: `fetch failed: ${err.message ?? err}` };
  }
  try {
    const log = await git.log({ from: "HEAD", to: "origin/HEAD", symmetric: false });
    return {
      commits: log.all.map((c) => ({
        hash: c.hash,
        shortHash: c.hash.slice(0, 7),
        author: c.author_name,
        date: c.date,
        message: c.message,
      })),
      message:
        log.all.length === 0
          ? "up to date"
          : `${log.all.length} incoming commit(s)`,
    };
  } catch (err: any) {
    return { commits: [], message: `log failed: ${err.message ?? err}` };
  }
}
