import { useEffect, useState } from "react";
import { Login } from "./pages/Login";
import { Editor } from "./pages/Editor";
import { api, type SessionInfo } from "./api";

const SESSION_KEY = "coleaf.sessionId";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      setLoading(false);
      return;
    }
    api
      .getSession(id)
      .then((s) => setSession(s))
      .catch(() => localStorage.removeItem(SESSION_KEY))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="login-wrap">Loading…</div>;
  }

  if (!session) {
    return (
      <Login
        onCreated={(s) => {
          localStorage.setItem(SESSION_KEY, s.id);
          setSession(s);
        }}
      />
    );
  }

  return (
    <Editor
      session={session}
      onLogout={() => {
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
      }}
    />
  );
}
