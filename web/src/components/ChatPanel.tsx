import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | {
      kind: "tool";
      name: string;
      input: any;
      result?: { content: string; is_error: boolean };
    };

export function ChatPanel(props: {
  sessionId: string;
  // Called when the agent likely modified files, so the host can refresh tree + active file.
  onWorkspaceMaybeChanged: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track the in-flight stream so we can abort it from a Stop button. The
  // boolean ref disambiguates "user stopped" from "real network error" so we
  // don't surface a noisy error bubble for an intentional cancel.
  const streamHandleRef = useRef<{ abort: () => void } | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [items]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    stoppedRef.current = false;

    setItems((prev) => [
      ...prev,
      { kind: "user", text },
      { kind: "assistant", text: "", streaming: true },
    ]);

    let workspaceChanged = false;

    const handle = api.streamAgent(props.sessionId, text, (event, data) => {
      if (event === "text") {
        setItems((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.kind === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + (data.delta ?? "") };
          }
          return next;
        });
      } else if (event === "tool_use") {
        setItems((prev) => {
          // Close out any currently-streaming assistant bubble
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.kind === "assistant" && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false };
            if (!last.text) next.pop(); // drop empty assistant bubble
          }
          next.push({ kind: "tool", name: data.name, input: data.input });
          return next;
        });
      } else if (event === "tool_result") {
        const writeTools = ["write_file", "edit_file", "git_commit"];
        setItems((prev) => {
          const next = [...prev];
          // Find the most recent matching tool entry without a result
          for (let i = next.length - 1; i >= 0; i--) {
            const item = next[i];
            if (item.kind === "tool" && !item.result) {
              next[i] = {
                ...item,
                result: { content: data.content, is_error: data.is_error },
              };
              if (writeTools.includes(item.name) && !data.is_error) {
                workspaceChanged = true;
              }
              break;
            }
          }
          // Open a fresh assistant bubble for any text that follows
          next.push({ kind: "assistant", text: "", streaming: true });
          return next;
        });
      } else if (event === "done" || event === "error") {
        setItems((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.kind === "assistant") {
            if (!last.text) next.pop();
            else next[next.length - 1] = { ...last, streaming: false };
          }
          if (event === "error") {
            next.push({
              kind: "tool",
              name: "error",
              input: {},
              result: { content: data.message ?? "unknown error", is_error: true },
            });
          }
          return next;
        });
      }
    });

    streamHandleRef.current = handle;
    try {
      await handle.done;
    } catch (err: any) {
      // If we aborted the fetch ourselves (Stop button), don't surface an
      // error — the [stopped] marker is added on the abort path below.
      if (!stoppedRef.current) {
        setItems((prev) => [
          ...prev,
          {
            kind: "tool",
            name: "error",
            input: {},
            result: { content: err?.message ?? String(err), is_error: true },
          },
        ]);
      }
    } finally {
      streamHandleRef.current = null;
      setBusy(false);
      if (workspaceChanged) props.onWorkspaceMaybeChanged();
    }
  }

  function stop() {
    if (!streamHandleRef.current) return;
    stoppedRef.current = true;
    streamHandleRef.current.abort();
    streamHandleRef.current = null;
    // Close out the streaming assistant bubble and append a [stopped] marker.
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.kind === "assistant") {
        if (!last.text) next.pop();
        else next[next.length - 1] = { ...last, streaming: false };
      }
      next.push({
        kind: "tool",
        name: "stopped",
        input: {},
        result: { content: "[stopped by user]", is_error: false },
      });
      return next;
    });
    setBusy(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function reset() {
    if (busy) return;
    if (!confirm("Clear conversation? The agent will forget context.")) return;
    await api.resetAgent(props.sessionId);
    setItems([]);
  }

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <span className="agent-dot" />
        Agent
        <button className="reset-btn" onClick={reset} disabled={busy}>
          New chat
        </button>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            Ask the agent to edit your paper.
            <div className="hint">
              Try: "tighten the abstract", "add a related work subsection", "fix references"
            </div>
          </div>
        )}
        {items.map((item, i) => {
          if (item.kind === "user") {
            return <div key={i} className="bubble user">{item.text}</div>;
          }
          if (item.kind === "assistant") {
            return (
              <div key={i} className="bubble assistant">
                {item.text}
                {item.streaming && <span style={{ opacity: 0.4 }}>▍</span>}
              </div>
            );
          }
          // tool
          const isErr = item.result?.is_error;
          return (
            <div key={i} className={`bubble tool ${isErr ? "error" : ""}`}>
              <div className="tool-name">
                {isErr ? "✗" : item.name === "web_search" ? "🔍" : "▸"} {item.name}
                {item.input?.path ? (
                  <span style={{ color: "#666", fontWeight: 400 }}> {item.input.path}</span>
                ) : null}
                {item.input?.message ? (
                  <span style={{ color: "#666", fontWeight: 400 }}> {`"${item.input.message}"`}</span>
                ) : null}
                {item.input?.query ? (
                  <span style={{ color: "#666", fontWeight: 400 }}> {`"${item.input.query}"`}</span>
                ) : null}
              </div>
              {item.result && (
                <pre>{item.result.content}</pre>
              )}
              {!item.result && <div style={{ color: "#999" }}>running…</div>}
            </div>
          );
        })}
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={busy ? "Agent is working… (click Stop to cancel)" : "Message your agent (Enter to send)"}
          disabled={busy}
          rows={1}
        />
        {busy ? (
          <button onClick={stop} className="stop-btn">
            Stop
          </button>
        ) : (
          <button onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
