import type { FileNode } from "../api";

function fileIcon(name: string): string {
  if (name.endsWith(".tex")) return "📄";
  if (name.endsWith(".bib")) return "📚";
  if (name.endsWith(".pdf")) return "📕";
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "🖼";
  if (name.endsWith(".md")) return "📝";
  return "📃";
}

function NodeRow(props: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  modifiedSet: Set<string>;
}) {
  const { node, depth, activePath, onOpen, modifiedSet } = props;
  const indent = { paddingLeft: `${10 + depth * 12}px` };

  if (node.type === "dir") {
    return (
      <div className="tree-node">
        <div className="tree-row" style={indent}>
          <span className="icon">📁</span>
          {node.name}
        </div>
        <div className="tree-children">
          {(node.children ?? []).map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              modifiedSet={modifiedSet}
            />
          ))}
        </div>
      </div>
    );
  }

  const isActive = activePath === node.path;
  const isModified = modifiedSet.has(node.path);
  return (
    <div
      className={`tree-row ${isActive ? "active" : ""}`}
      style={indent}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <span className="icon">{fileIcon(node.name)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
      {isModified && <span style={{ marginLeft: 6, color: "#ffb74d" }}>●</span>}
    </div>
  );
}

export function FileTree(props: {
  files: FileNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  modified: string[];
}) {
  const modifiedSet = new Set(props.modified);
  return (
    <div className="sidebar">
      <div className="sidebar-header">Project Files</div>
      {props.files.map((node) => (
        <NodeRow
          key={node.path}
          node={node}
          depth={0}
          activePath={props.activePath}
          onOpen={props.onOpen}
          modifiedSet={modifiedSet}
        />
      ))}
    </div>
  );
}
