import { useState } from "react";

export type CompileState =
  | { kind: "idle" }
  | { kind: "compiling" }
  | { kind: "success"; mainTex: string; durationMs: number; pdfVersion: number; log: string }
  | { kind: "error"; log: string; durationMs: number };

export function PdfPane(props: {
  sessionId: string;
  state: CompileState;
  onRecompile: () => void;
}) {
  const [showLog, setShowLog] = useState(false);

  return (
    <div className="pdf-pane">
      <div className="pdf-header">
        <span style={{ fontWeight: 600 }}>PDF Preview</span>
        {props.state.kind === "success" && (
          <span className="pdf-meta">
            {props.state.mainTex} · {(props.state.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {props.state.kind === "error" && <span className="pdf-meta error">build failed</span>}
        {props.state.kind === "compiling" && <span className="pdf-meta">compiling…</span>}
        <button
          className="reset-btn"
          onClick={() => setShowLog((v) => !v)}
          disabled={props.state.kind === "idle"}
          title="Toggle compile log"
        >
          {showLog ? "Hide log" : "Log"}
        </button>
        <button
          className="reset-btn"
          onClick={props.onRecompile}
          disabled={props.state.kind === "compiling"}
        >
          {props.state.kind === "compiling" ? "…" : "Recompile"}
        </button>
      </div>

      <div className="pdf-body">
        {props.state.kind === "idle" && (
          <div className="pdf-empty">
            Click <strong>Recompile</strong> to render the PDF.
          </div>
        )}

        {props.state.kind === "compiling" && (
          <div className="pdf-empty">Running latexmk…</div>
        )}

        {props.state.kind === "success" && (
          <iframe
            key={props.state.pdfVersion}
            className="pdf-frame"
            src={`/api/sessions/${props.sessionId}/pdf?t=${props.state.pdfVersion}`}
            title="PDF preview"
          />
        )}

        {props.state.kind === "error" && (
          <div className="pdf-error">
            <div className="pdf-error-title">LaTeX compile failed</div>
            <pre>{extractErrors(props.state.log)}</pre>
          </div>
        )}

        {showLog &&
          (props.state.kind === "success" || props.state.kind === "error") && (
            <div className="pdf-log-overlay">
              <pre>{props.state.log}</pre>
            </div>
          )}
      </div>
    </div>
  );
}

// Pull just the file:line:error lines from a latexmk log so the failure box
// shows actionable info instead of 500 lines of font path noise.
function extractErrors(log: string): string {
  const lines = log.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // file-line-error format: "/path/file.tex:42: Some error"
    if (/:\d+:\s/.test(line) || /^!\s/.test(line) || /^l\.\d+/.test(line)) {
      out.push(line);
      // Include 2 lines of context after `! ...` errors
      if (line.startsWith("!")) {
        for (let j = 1; j <= 3 && i + j < lines.length; j++) {
          out.push(lines[i + j]);
        }
      }
    }
  }
  if (out.length === 0) {
    // Fall back to last 30 lines
    return lines.slice(-30).join("\n");
  }
  return out.join("\n");
}
