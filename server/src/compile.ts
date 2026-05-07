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

type TexCandidate = {
  relPath: string;
  content: string;
};

const MAIN_TEX_ENV = "COLEAF_MAIN_TEX";

/**
 * Find the project's main .tex file by looking for `\documentclass`.
 *
 * Overleaf projects often keep several entry points (`main.tex`,
 * `main-arxiv.tex`, `main-nips.tex`, camera-ready copies, etc.). A plain
 * "prefer main.tex" rule is brittle because `main.tex` is often the conference
 * template while a suffixed file is the buildable entry point.
 */
async function findMainTex(
  workspaceDir: string,
  preferredPath?: string,
): Promise<string | null> {
  const candidates = await findTexCandidates(workspaceDir);
  if (candidates.length === 0) return null;

  const explicit = normalizeTexPath(
    preferredPath || process.env[MAIN_TEX_ENV] || "",
  );
  if (explicit) {
    const match = candidates.find((c) => c.relPath === explicit);
    if (match) return match.relPath;
  }

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return candidates[0].relPath;
}

async function findTexCandidates(workspaceDir: string): Promise<TexCandidate[]> {
  const candidates: TexCandidate[] = [];

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    const absDir = path.join(workspaceDir, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith("_minted-")) {
        continue;
      }
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childRel, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".tex")) {
        const content = await fs.readFile(path.join(workspaceDir, childRel), "utf-8");
        if (/\\documentclass\b/.test(content)) {
          candidates.push({ relPath: childRel, content });
        }
      }
    }
  }

  await walk("", 0);
  return candidates;
}

function normalizeTexPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || !trimmed.endsWith(".tex")) return null;
  return trimmed.replace(/^\.\/+/, "").split(path.sep).join("/");
}

function scoreCandidate(candidate: TexCandidate): number {
  const rel = candidate.relPath;
  const name = path.basename(rel).toLowerCase();
  const dir = path.dirname(rel).toLowerCase();
  const content = candidate.content;
  let score = 0;

  if (name === "main.tex") score += 40;
  if (/^main[-_].+\.tex$/.test(name)) score += 80;
  if (/(nips|neurips|icml|iclr|acl|emnlp|cvpr|eccv|iccv|camera)/.test(name)) {
    score += 35;
  }
  if (/(arxiv|preprint)/.test(name)) score += 20;
  if (/(nips|neurips|icml|iclr|acl|emnlp|cvpr|eccv|iccv|camera)/.test(dir)) {
    score += 15;
  }
  if (/(arxiv|preprint)/.test(dir)) score += 8;
  if (/\\begin\{document\}/.test(content)) score += 20;
  if (/\\maketitle\b/.test(content)) score += 10;
  if (/\\input\{|\u005cinclude\{/.test(content)) score += 5;
  score -= rel.split("/").length * 2;

  return score;
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

export async function compile(
  workspaceDir: string,
  preferredMainTex?: string,
): Promise<CompileResult> {
  const started = Date.now();
  const mainTex = await findMainTex(workspaceDir, preferredMainTex);
  if (!mainTex) {
    const result: CompileResult = {
      ok: false,
      mainTex: null,
      pdfPath: null,
      log: "No .tex file with \\documentclass found in the project workspace.",
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
  const mainDir = path.dirname(path.join(workspaceDir, mainTex));
  const code = await new Promise<number>((resolve) => {
    const proc = spawn("latexmk", args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        // Search both the workspace root and the entrypoint's directory.
        // Some Overleaf projects keep format-specific mains in subfolders,
        // together with their .sty/.bib support files.
        BIBINPUTS: `${workspaceDir}:${mainDir}:`,
        TEXINPUTS: `${workspaceDir}:${mainDir}:`,
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

  const pdfCandidates = [
    // latexmk writes outputs to cwd by default, even when the source file is
    // passed as a subdirectory path.
    `${path.basename(mainTex, ".tex")}.pdf`,
    `${mainTex.replace(/\.tex$/, "")}.pdf`,
  ];
  const pdfRel = pdfCandidates.find((p) => existsSync(path.join(workspaceDir, p)));
  const pdfAbs = pdfRel ? path.join(workspaceDir, pdfRel) : null;

  if (pdfRel) {
    // Hide the main PDF from git: add to local exclude (covers the untracked
    // case) and mark skip-worktree (covers the tracked case where Overleaf
    // committed the prior PDF). Both are idempotent and per-clone only.
    await ensurePdfExcluded(workspaceDir, pdfRel);
  }

  const result: CompileResult = {
    ok: code === 0 && !!pdfAbs,
    mainTex,
    pdfPath: pdfAbs,
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
