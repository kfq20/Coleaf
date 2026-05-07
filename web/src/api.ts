export type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
};

export type GitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  not_added: string[];
  deleted: string[];
  staged: string[];
  conflicted: string[];
  rebasing: boolean;
};

export type SyncResult =
  | { status: "success"; pulled: number; pushed: number; message: string }
  | { status: "conflict"; files: string[]; message: string }
  | { status: "pull_failed"; message: string }
  | { status: "push_failed"; pulled: number; message: string };

export type IncomingCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
};

export type SessionInfo = {
  id: string;
  displayName: string;
  model: string;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  createSession(input: {
    displayName: string;
    gitUrl: string;
    gitToken: string;
    anthropicBaseUrl: string;
    anthropicAuthToken: string;
    model?: string;
  }) {
    return jsonFetch<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getSession(id: string) {
    return jsonFetch<SessionInfo>(`/api/sessions/${id}`);
  },

  listFiles(id: string) {
    return jsonFetch<FileNode[]>(`/api/sessions/${id}/files`);
  },

  readFile(id: string, path: string) {
    return jsonFetch<{ path: string; content: string }>(
      `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,
    );
  },

  writeFile(id: string, path: string, content: string) {
    return jsonFetch<{ ok: true }>(`/api/sessions/${id}/file`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
  },

  gitStatus(id: string) {
    return jsonFetch<GitStatus>(`/api/sessions/${id}/git/status`);
  },

  gitCommit(id: string, message: string) {
    return jsonFetch<{ committed: boolean; hash?: string; message: string }>(
      `/api/sessions/${id}/git/commit`,
      { method: "POST", body: JSON.stringify({ message }) },
    );
  },

  gitSync(id: string) {
    return jsonFetch<SyncResult>(`/api/sessions/${id}/git/sync`, { method: "POST" });
  },

  gitSyncAbort(id: string) {
    return jsonFetch<{ aborted: boolean; message: string }>(
      `/api/sessions/${id}/git/sync/abort`,
      { method: "POST" },
    );
  },

  gitSyncContinue(id: string) {
    return jsonFetch<SyncResult>(
      `/api/sessions/${id}/git/sync/continue`,
      { method: "POST" },
    );
  },

  gitSyncResolve(id: string, side: "mine" | "remote") {
    return jsonFetch<SyncResult>(`/api/sessions/${id}/git/sync/resolve`, {
      method: "POST",
      body: JSON.stringify({ side }),
    });
  },

  gitIncoming(id: string) {
    return jsonFetch<{ commits: IncomingCommit[]; message: string }>(
      `/api/sessions/${id}/git/incoming`,
    );
  },

  resetAgent(id: string) {
    return jsonFetch<{ ok: true }>(`/api/sessions/${id}/agent/reset`, {
      method: "POST",
    });
  },

  compile(id: string, mainTex?: string) {
    return jsonFetch<{ ok: boolean; mainTex: string | null; log: string; durationMs: number }>(
      `/api/sessions/${id}/compile`,
      { method: "POST", body: JSON.stringify({ mainTex }) },
    );
  },

  pdfUrl(id: string, cacheBust: number) {
    return `/api/sessions/${id}/pdf?t=${cacheBust}`;
  },

  // SSE streaming agent. Calls onEvent for each event; resolves on done/error.
  streamAgent(
    id: string,
    message: string,
    onEvent: (event: string, data: any) => void,
  ): { abort: () => void; done: Promise<void> } {
    const controller = new AbortController();
    const done = (async () => {
      const res = await fetch(`/api/sessions/${id}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        let messageText = body || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(body);
          messageText = parsed.error ?? parsed.message ?? messageText;
        } catch {
          // Non-JSON error body; surface it as-is.
        }
        throw new Error(messageText);
      }
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE: events separated by blank line
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split("\n");
          let event = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (dataStr) {
            try {
              onEvent(event, JSON.parse(dataStr));
            } catch {
              onEvent(event, dataStr);
            }
          }
        }
      }
    })();
    return { abort: () => controller.abort(), done };
  },
};
