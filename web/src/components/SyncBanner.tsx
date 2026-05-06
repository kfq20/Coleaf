import type { SyncResult } from "../api";

type Props = {
  state:
    | { kind: "idle" }
    | { kind: "running"; phase: "syncing" | "continuing" | "aborting" }
    | { kind: "result"; result: SyncResult }
    | { kind: "conflict"; files: string[]; message: string };
  onOpenFile: (path: string) => void;
  onAbort: () => void;
  onContinue: () => void;
  onResolve: (side: "mine" | "remote") => void;
  onDismiss: () => void;
};

export function SyncBanner(props: Props) {
  const { state } = props;

  if (state.kind === "idle") return null;

  if (state.kind === "running") {
    return (
      <div className="sync-banner running">
        <span className="dot" />
        {state.phase === "syncing" && "Syncing with Overleaf…"}
        {state.phase === "continuing" && "Continuing rebase after resolution…"}
        {state.phase === "aborting" && "Aborting rebase…"}
      </div>
    );
  }

  if (state.kind === "conflict") {
    return (
      <div className="sync-banner conflict">
        <div className="banner-row">
          <span className="banner-icon">⚠</span>
          <strong>Sync paused — merge conflict</strong>
          <span className="banner-msg">{state.message}</span>
          <div className="banner-actions">
            <button
              className="btn-ghost"
              onClick={() => props.onResolve("mine")}
              title="Overwrite remote with your version"
            >
              Use my version
            </button>
            <button
              className="btn-ghost"
              onClick={() => props.onResolve("remote")}
              title="Discard your edits to these files, take Overleaf's"
            >
              Use remote version
            </button>
            <button className="btn-ghost" onClick={props.onAbort}>
              Abort sync
            </button>
            <button className="btn-primary" onClick={props.onContinue}>
              Continue (manual)
            </button>
          </div>
        </div>
        <div className="conflict-files">
          {state.files.map((f) => (
            <button
              key={f}
              className="conflict-file"
              onClick={() => props.onOpenFile(f)}
              title="Open and resolve"
            >
              <span className="icon">⚠</span>
              {f}
            </button>
          ))}
        </div>
        <div className="conflict-help">
          <strong>Use my version</strong> keeps your edits and overwrites remote on push.{" "}
          <strong>Use remote version</strong> discards your edits to these files. Or
          open each file, edit out the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> /{" "}
          <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers, save, then click{" "}
          <strong>Continue (manual)</strong>.
        </div>
      </div>
    );
  }

  // result
  const r = state.result;
  if (r.status === "success") {
    return (
      <div className="sync-banner success">
        <span className="banner-icon">✓</span>
        Synced — {r.message}
        <button className="banner-close" onClick={props.onDismiss}>
          ×
        </button>
      </div>
    );
  }
  if (r.status === "pull_failed" || r.status === "push_failed") {
    return (
      <div className="sync-banner error">
        <span className="banner-icon">✗</span>
        {r.message}
        <button className="banner-close" onClick={props.onDismiss}>
          ×
        </button>
      </div>
    );
  }
  return null;
}
