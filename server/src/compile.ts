import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";

// LaTeX intermediate file extensions that we keep in the workspace root
// (so minted/etc. can find their own caches) but hide from git via
// .git/info/exclude.
const LATEX_ARTIFACTS = [
  "*.aux", "*.log", "*.out", "*.toc", "*.lof", "*.lot",
  "*.bbl", "*.blg", "*.fls", "*.fdb_latexmk", "*.synctex.gz",
  "*.run.xml", "*.bcf", "*.nav", "*.snm", "*.vrb",
  "_minted-*/", "**/_minted-*/",
  ".coleaf-build/",
  // Persisted session metadata — must never be committed (contains tokens)
  "/.coleaf-session.json",
];

export type CompileResult = {
  ok: boolean;
  mainTex: string | null;
  pdfPath: string | null; // absolute path on the server, when ok
  log: string;
  durationMs: number;
};

// Track the most recent compile per workspace so the /pdf endpoint can find it
const lastCompileByWorkspace = new Map<string, CompileResult>();

export function getLastCompile(workspaceDir: string): CompileResult | undefined {
  return lastCompileByWorkspace.get(workspaceDir);
}

/**
 * Find the project's main .tex file by looking for `\documentclass` at the
 * top level. Prefers `main.tex` if present.
 */
async function findMainTex(workspaceDir: string): Promise<string | null> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  const candidates: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".tex")) {
      const content = await fs.readFile(path.join(workspaceDir, e.name), "utf-8");
      if (/\\documentclass\b/.test(content)) candidates.push(e.name);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.find((n) => n === "main.tex") ?? candidates[0];
}

/**
 * Add LaTeX intermediate-file patterns to the local-only git exclude so
 * compile artifacts don't show up as dirty in `git status`.
 */
export async function ensureBuildExclude(workspaceDir: string): Promise<void> {
  const excludePath = path.join(workspaceDir, ".git", "info", "exclude");
  try {
    const current = existsSync(excludePath) ? await fs.readFile(excludePath, "utf-8") : "";
    const missing = LATEX_ARTIFACTS.filter((p) => !current.includes(p));
    if (missing.length > 0) {
      await fs.appendFile(excludePath, `\n# coleaf-managed latex artifacts\n${missing.join("\n")}\n`);
    }
  } catch {
    // best-effort; not fatal if it fails
  }
}

export async function compile(workspaceDir: string): Promise<CompileResult> {
  const started = Date.now();
  const mainTex = await findMainTex(workspaceDir);
  if (!mainTex) {
    const result: CompileResult = {
      ok: false,
      mainTex: null,
      pdfPath: null,
      log: "No .tex file with \\documentclass found at the project root.",
      durationMs: 0,
    };
    lastCompileByWorkspace.set(workspaceDir, result);
    return result;
  }

  // We compile in the workspace root (not a separate outdir) because packages
  // like `minted` write caches with relative paths that break under -outdir.
  // The intermediate files are hidden from git via .git/info/exclude.
  // -shell-escape lets `minted` invoke pygmentize. The workspace is per-session
  // and the user owns the .tex source, so this is acceptable here — but it
  // does mean a malicious .tex file could run shell commands.
  const args = [
    "-pdf",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-shell-escape",
    mainTex,
  ];

  let stdout = "";
  let stderr = "";
  const code = await new Promise<number>((resolve) => {
    const proc = spawn("latexmk", args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        // Keep the bibliography aux files in the build dir too
        BIBINPUTS: workspaceDir,
        TEXINPUTS: `${workspaceDir}:`,
      },
    });
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve(127);
    });
    proc.on("close", (exitCode) => resolve(exitCode ?? 1));
    // Cap at 90s — latexmk should never take that long for a paper
    setTimeout(() => proc.kill("SIGKILL"), 90_000).unref();
  });

  const log = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")).trim();

  const baseName = mainTex.replace(/\.tex$/, "");
  const pdfRel = `${baseName}.pdf`;
  const pdfAbs = path.join(workspaceDir, pdfRel);
  const pdfExists = existsSync(pdfAbs);

  if (pdfExists) {
    // Hide the main PDF from git: add to local exclude (covers the untracked
    // case) and mark skip-worktree (covers the tracked case where Overleaf
    // committed the prior PDF). Both are idempotent and per-clone only.
    await ensurePdfExcluded(workspaceDir, pdfRel);
  }

  const result: CompileResult = {
    ok: code === 0 && pdfExists,
    mainTex,
    pdfPath: pdfExists ? pdfAbs : null,
    log,
    durationMs: Date.now() - started,
  };
  lastCompileByWorkspace.set(workspaceDir, result);
  return result;
}

async function ensurePdfExcluded(workspaceDir: string, pdfRel: string): Promise<void> {
  const excludePath = path.join(workspaceDir, ".git", "info", "exclude");
  try {
    const current = existsSync(excludePath) ? await fs.readFile(excludePath, "utf-8") : "";
    if (!current.split("\n").some((line) => line.trim() === `/${pdfRel}`)) {
      await fs.appendFile(excludePath, `\n/${pdfRel}\n`);
    }
  } catch {
    /* ignore */
  }
  // If the file is tracked, mark it skip-worktree so modifications don't show
  // up. If it's not tracked, this errors silently and the exclude alone covers it.
  try {
    const git = simpleGit(workspaceDir);
    const ls = await git.raw(["ls-files", "--error-unmatch", pdfRel]).catch(() => "");
    if (ls.trim()) {
      await git.raw(["update-index", "--skip-worktree", pdfRel]).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}
