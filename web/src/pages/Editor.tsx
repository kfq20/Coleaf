import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type FileNode,
  type GitStatus,
  type IncomingCommit,
  type SessionInfo,
  type SyncResult,
} from "../api";
import { FileTree } from "../components/FileTree";
import { EditorPane } from "../components/EditorPane";
import { ChatPanel } from "../components/ChatPanel";
import { PdfPane, type CompileState } from "../components/PdfPane";
import { SyncBanner } from "../components/SyncBanner";
import { PullPreviewModal } from "../components/PullPreviewModal";

type SyncBannerState =
  | { kind: "idle" }
  | { kind: "running"; phase: "syncing" | "continuing" | "aborting" }
  | { kind: "result"; result: SyncResult }
  | { kind: "conflict"; files: string[]; message: string };

export function Editor(props: { session: SessionInfo; onLogout: () => void }) {
  const { session } = props;
  const [files, setFiles] = useState<FileNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [serverContent, setServerContent] = useState<string>("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [syncBanner, setSyncBanner] = useState<SyncBannerState>({ kind: "idle" });
  const [pullPreview, setPullPreview] = useState<
    | { open: false }
    | { open: true; loading: true }
    | { open: true; loading: false; commits: IncomingCommit[]; message: string }
  >({ open: false });
  const [compileState, setCompileState] = useState<CompileState>({ kind: "idle" });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfVersionRef = useRef(0);

  const recompile = useCallback(async (mainTex?: string) => {
    setCompileState({ kind: "compiling" });
    try {
      const result = await api.compile(session.id, mainTex);
      if (result.ok && result.mainTex) {
        pdfVersionRef.current += 1;
        setCompileState({
          kind: "success",
          mainTex: result.mainTex,
          durationMs: result.durationMs,
          pdfVersion: pdfVersionRef.current,
          log: result.log,
        });
      } else {
        setCompileState({
          kind: "error",
          log: result.log || "compile failed (no log)",
          durationMs: result.durationMs,
        });
      }
    } catch (err: any) {
      setCompileState({
        kind: "error",
        log: err?.message ?? String(err),
        durationMs: 0,
      });
    }
  }, [session.id]);

  // Debounced recompile — call after a save / agent edit, fires once after
  // ~1.2s of no further triggers
  const scheduleRecompile = useCallback(() => {
    if (compileTimer.current) clearTimeout(compileTimer.current);
    compileTimer.current = setTimeout(() => {
      recompile(activePath?.endsWith(".tex") ? activePath : undefined);
    }, 1200);
  }, [activePath, recompile]);

  const refreshFiles = useCallback(async () => {
    try {
      const f = await api.listFiles(session.id);
      setFiles(f);
    } catch (err) {
      console.error("listFiles failed", err);
    }
  }, [session.id]);

  const refreshGit = useCallback(async () => {
    try {
      setGitStatus(await api.gitStatus(session.id));
    } catch (err) {
      console.error("gitStatus failed", err);
    }
  }, [session.id]);

  useEffect(() => {
    refreshFiles();
    refreshGit();
    // Trigger initial compile so the PDF shows up on first load
    recompile();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-pick a sensible default: prefer main.tex, else first .tex, else first file
  useEffect(() => {
    if (activePath || files.length === 0) return;
    const flat: FileNode[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") flat.push(n);
        else if (n.children) walk(n.children);
      }
    };
    walk(files);
    const main = flat.find((f) => f.name === "main.tex");
    const firstTex = flat.find((f) => f.name.endsWith(".tex"));
    const target = main ?? firstTex ?? flat[0];
    if (target) openFile(target.path);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  async function openFile(path: string) {
    try {
      const { content } = await api.readFile(session.id, path);
      setActivePath(path);
      setContent(content);
      setServerContent(content);
      setSaveState("saved");
    } catch (err) {
      console.error("openFile failed", err);
    }
  }

  function onEdit(value: string) {
    setContent(value);
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveActive(value);
    }, 600);
  }

  async function saveActive(value: string) {
    if (!activePath) return;
    setSaveState("saving");
    try {
      await api.writeFile(session.id, activePath, value);
      setServerContent(value);
      setSaveState("saved");
      refreshGit();
      // Auto-recompile only for files that actually go into the build
      if (/\.(tex|sty|cls|bib|bst)$/i.test(activePath)) {
        scheduleRecompile();
      }
    } catch (err) {
      console.error("save failed", err);
      setSaveState("dirty");
    }
  }

  async function handleAgentChange() {
    // Agent edited files; reload tree and the currently-open file (in case the agent rewrote it)
    await refreshFiles();
    await refreshGit();
    if (activePath) {
      try {
        const { content: latest } = await api.readFile(session.id, activePath);
        // Only overwrite if the user has no unsaved local changes
        if (saveState === "saved" && latest !== serverContent) {
          setContent(latest);
          setServerContent(latest);
        }
      } catch (err) {
        console.error("reload after agent edit failed", err);
      }
    }
    scheduleRecompile();
  }

  async function reloadActiveFile() {
    if (!activePath) return;
    try {
      const { content: latest } = await api.readFile(session.id, activePath);
      setContent(latest);
      setServerContent(latest);
      setSaveState("saved");
    } catch (err) {
      console.error("reload active file failed", err);
    }
  }

  async function applySyncResult(result: SyncResult) {
    if (result.status === "conflict") {
      setSyncBanner({ kind: "conflict", files: result.files, message: result.message });
    } else {
      setSyncBanner({ kind: "result", result });
    }
    await refreshFiles();
    await refreshGit();
    await reloadActiveFile();
  }

  async function syncNow() {
    if (syncBanner.kind === "running") return;
    setSyncBanner({ kind: "running", phase: "syncing" });
    try {
      const result = await api.gitSync(session.id);
      await applySyncResult(result);
    } catch (err: any) {
      setSyncBanner({
        kind: "result",
        result: { status: "pull_failed", message: err?.message ?? String(err) },
      });
    }
  }

  async function abortSync() {
    setSyncBanner({ kind: "running", phase: "aborting" });
    try {
      const r = await api.gitSyncAbort(session.id);
      setSyncBanner({
        kind: "result",
        result: r.aborted
          ? { status: "success", pulled: 0, pushed: 0, message: r.message }
          : { status: "pull_failed", message: r.message },
      });
      await refreshFiles();
      await refreshGit();
      await reloadActiveFile();
    } catch (err: any) {
      setSyncBanner({
        kind: "result",
        result: { status: "pull_failed", message: err?.message ?? String(err) },
      });
    }
  }

  async function continueSync() {
    setSyncBanner({ kind: "running", phase: "continuing" });
    try {
      const result = await api.gitSyncContinue(session.id);
      await applySyncResult(result);
    } catch (err: any) {
      setSyncBanner({
        kind: "result",
        result: { status: "pull_failed", message: err?.message ?? String(err) },
      });
    }
  }

  async function resolveSync(side: "mine" | "remote") {
    setSyncBanner({ kind: "running", phase: "continuing" });
    try {
      const result = await api.gitSyncResolve(session.id, side);
      await applySyncResult(result);
    } catch (err: any) {
      setSyncBanner({
        kind: "result",
        result: { status: "pull_failed", message: err?.message ?? String(err) },
      });
    }
  }

  async function openPullPreview() {
    setPullPreview({ open: true, loading: true });
    try {
      const r = await api.gitIncoming(session.id);
      setPullPreview({
        open: true,
        loading: false,
        commits: r.commits,
        message: r.message,
      });
    } catch (err: any) {
      setPullPreview({
        open: true,
        loading: false,
        commits: [],
        message: err?.message ?? String(err),
      });
    }
  }

  const modified = gitStatus
    ? [...gitStatus.modified, ...gitStatus.not_added, ...gitStatus.staged]
    : [];

  const dirty =
    !!gitStatus &&
    gitStatus.modified.length + gitStatus.not_added.length + gitStatus.deleted.length > 0;

  const conflicted = gitStatus?.conflicted ?? [];
  const inConflict = (gitStatus?.rebasing ?? false) || conflicted.length > 0;
  const syncBusy = syncBanner.kind === "running";

  // If git says we're in a rebase but the banner is idle (e.g. on first
  // load after server restart), surface the conflict.
  useEffect(() => {
    if (inConflict && syncBanner.kind === "idle") {
      setSyncBanner({
        kind: "conflict",
        files: conflicted,
        message: `${conflicted.length} file(s) need resolving — left over from a previous sync.`,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inConflict, conflicted.length]);

  return (
    <div className="editor-root">
      <div className="topbar">
        <div className="brand">Coleaf</div>
        <div className="project-name">· {session.displayName}</div>
        <div className="grow" />
        <div className={`git-status ${dirty ? "dirty" : ""}`}>
          {gitStatus
            ? `${gitStatus.branch} ${dirty ? `· ${modified.length} changed` : "· clean"}${
                gitStatus.ahead ? ` · ↑${gitStatus.ahead}` : ""
              }${gitStatus.behind ? ` · ↓${gitStatus.behind}` : ""}${
                conflicted.length ? ` · ⚠ ${conflicted.length} conflict` : ""
              }`
            : "…"}
        </div>
        <button
          className="btn-ghost"
          onClick={openPullPreview}
          disabled={syncBusy}
          title="Fetch + show incoming commits without merging"
        >
          Pull preview
        </button>
        <button
          className="btn-ghost"
          onClick={syncNow}
          disabled={syncBusy || inConflict}
        >
          {syncBusy ? "Syncing…" : "Sync to Overleaf"}
        </button>
        <button className="btn-ghost" onClick={props.onLogout}>
          Logout
        </button>
      </div>

      <SyncBanner
        state={syncBanner}
        onOpenFile={openFile}
        onAbort={abortSync}
        onContinue={continueSync}
        onResolve={resolveSync}
        onDismiss={() => setSyncBanner({ kind: "idle" })}
      />

      <div className="editor-body">
        <FileTree
          files={files}
          activePath={activePath}
          onOpen={openFile}
          modified={modified}
        />
        <EditorPane
          path={activePath}
          content={content}
          onChange={onEdit}
          saveState={saveState}
        />
        <PdfPane
          sessionId={session.id}
          state={compileState}
          onRecompile={() =>
            recompile(activePath?.endsWith(".tex") ? activePath : undefined)
          }
        />
        <ChatPanel
          sessionId={session.id}
          onWorkspaceMaybeChanged={handleAgentChange}
        />
      </div>

      {pullPreview.open && (
        <PullPreviewModal
          commits={"commits" in pullPreview ? pullPreview.commits : []}
          message={
            "loading" in pullPreview && pullPreview.loading
              ? "Fetching from origin…"
              : "message" in pullPreview
                ? pullPreview.message
                : ""
          }
          busy={syncBusy}
          onSync={async () => {
            setPullPreview({ open: false });
            await syncNow();
          }}
          onClose={() => setPullPreview({ open: false })}
        />
      )}
    </div>
  );
}
