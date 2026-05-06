import { useState } from "react";
import { api, type SessionInfo } from "../api";

export function Login(props: { onCreated: (s: SessionInfo) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("https://api.openai.com/v1");
  const [anthropicAuthToken, setAnthropicAuthToken] = useState("");
  const [model, setModel] = useState("gpt-5.5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSession({
        displayName,
        gitUrl,
        gitToken,
        anthropicBaseUrl,
        anthropicAuthToken,
        model,
      });
      props.onCreated(s);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Coleaf</h1>
        <p className="tagline">Collaborative LaTeX writing with your own coding agent.</p>

        <div className="login-section">
          <h3>You</h3>
          <div className="field">
            <label>Display name</label>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alice"
            />
            <div className="hint">Shown to collaborators in git commits.</div>
          </div>
        </div>

        <div className="login-section">
          <h3>Overleaf project</h3>
          <div className="field">
            <label>Git URL</label>
            <input
              required
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://git.overleaf.com/&lt;project-id&gt;"
            />
          </div>
          <div className="field">
            <label>Git token</label>
            <input
              required
              type="password"
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
              placeholder="Overleaf personal access token"
            />
            <div className="hint">
              Generate one in Overleaf → Account Settings → Project &amp; Account Access Tokens.
            </div>
          </div>
        </div>

        <div className="login-section">
          <h3>Your coding agent (OpenAI-compatible Responses API)</h3>
          <div className="field">
            <label>Base URL</label>
            <input
              required
              value={anthropicBaseUrl}
              onChange={(e) => setAnthropicBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
            <div className="hint">
              Any OpenAI-compatible endpoint exposing <code>/v1/responses</code>.
            </div>
          </div>
          <div className="field">
            <label>Auth token</label>
            <input
              required
              type="password"
              value={anthropicAuthToken}
              onChange={(e) => setAnthropicAuthToken(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="field">
            <label>Model</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-5.5"
            />
            <div className="hint">
              e.g. <code>gpt-5</code> / <code>gpt-4o</code> on openai.com,
              or any compatible proxy model name.
            </div>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <button className="btn btn-full" type="submit" disabled={busy}>
          {busy ? "Cloning project…" : "Open project"}
        </button>
      </form>
    </div>
  );
}
