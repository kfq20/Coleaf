import type { IncomingCommit } from "../api";

export function PullPreviewModal(props: {
  commits: IncomingCommit[];
  message: string;
  busy: boolean;
  onSync: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ fontWeight: 600 }}>Incoming changes from Overleaf</span>
          <button className="modal-close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="modal-meta">{props.message}</div>
        <div className="modal-body">
          {props.commits.length === 0 ? (
            <div className="modal-empty">No new commits — you're up to date.</div>
          ) : (
            <ul className="commit-list">
              {props.commits.map((c) => (
                <li key={c.hash} className="commit-item">
                  <div className="commit-line">
                    <code>{c.shortHash}</code>
                    <strong>{c.author}</strong>
                    <span className="commit-date">
                      {new Date(c.date).toLocaleString()}
                    </span>
                  </div>
                  <div className="commit-msg">{c.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-ghost-dark" onClick={props.onClose}>
            Close
          </button>
          {props.commits.length > 0 && (
            <button className="btn-primary" onClick={props.onSync} disabled={props.busy}>
              {props.busy ? "Syncing…" : "Sync now (pull + push)"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
