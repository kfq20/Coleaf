import Editor from "@monaco-editor/react";

function languageFor(path: string | null): string {
  if (!path) return "plaintext";
  if (path.endsWith(".tex") || path.endsWith(".sty") || path.endsWith(".bbl")) return "latex";
  if (path.endsWith(".bib")) return "bibtex";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".py")) return "python";
  return "plaintext";
}

export function EditorPane(props: {
  path: string | null;
  content: string;
  onChange: (value: string) => void;
  saveState: "saved" | "saving" | "dirty";
}) {
  if (!props.path) {
    return (
      <div className="editor-pane">
        <div className="editor-empty">Pick a file from the sidebar to start editing.</div>
      </div>
    );
  }

  const stateLabel =
    props.saveState === "saving" ? "saving…" :
    props.saveState === "dirty" ? "unsaved" :
    "saved";

  return (
    <div className="editor-pane">
      <div className="editor-tabs">
        <div className="current-file">{props.path}</div>
        <div className="save-state">{stateLabel}</div>
      </div>
      <div className="editor-host">
        <Editor
          path={props.path}
          language={languageFor(props.path)}
          value={props.content}
          onChange={(v) => props.onChange(v ?? "")}
          theme="vs"
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}
