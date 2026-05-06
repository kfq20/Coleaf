import express from "express";
import cors from "cors";
import { createSession, deleteSession, getSession, loadSessionsFromDisk } from "./sessions.js";
import { listTree, readFile, writeFile } from "./files.js";
import {
  commitAll,
  status as gitStatus,
  sync as gitSync,
  abortSync,
  continueSync,
  resolveConflictWith,
  incoming as gitIncoming,
} from "./git.js";
import { runAgentTurn, resetAgent } from "./agent.js";
import { compile, ensureBuildExclude, getLastCompile } from "./compile.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Sessions ─────────────────────────────────────────────────────────
app.post("/api/sessions", async (req, res) => {
  try {
    const {
      displayName,
      gitUrl,
      gitToken,
      anthropicBaseUrl,
      anthropicAuthToken,
      model,
    } = req.body ?? {};
    if (!displayName || !gitUrl || !gitToken || !anthropicBaseUrl || !anthropicAuthToken) {
      return res.status(400).json({ error: "missing required fields" });
    }
    const session = await createSession({
      displayName,
      gitUrl,
      gitToken,
      anthropicBaseUrl,
      anthropicAuthToken,
      model,
    });
    await ensureBuildExclude(session.workspaceDir);
    res.json({
      id: session.id,
      displayName: session.displayName,
      model: session.model,
    });
  } catch (err: any) {
    console.error("create session failed", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  const ok = await deleteSession(req.params.id);
  res.json({ ok });
});

app.get("/api/sessions/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  res.json({ id: s.id, displayName: s.displayName, model: s.model });
});

// ─── Files ─────────────────────────────────────────────────────────────
app.get("/api/sessions/:id/files", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    const tree = await listTree(s.workspaceDir);
    res.json(tree);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/sessions/:id/file", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const path = req.query.path as string;
  if (!path) return res.status(400).json({ error: "missing path" });
  try {
    const content = await readFile(s.workspaceDir, path);
    res.json({ path, content });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.put("/api/sessions/:id/file", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const { path, content } = req.body ?? {};
  if (!path || typeof content !== "string") {
    return res.status(400).json({ error: "missing path or content" });
  }
  try {
    await writeFile(s.workspaceDir, path, content);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── Git ───────────────────────────────────────────────────────────────
app.get("/api/sessions/:id/git/status", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json(await gitStatus(s.workspaceDir));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/git/commit", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const message = req.body?.message ?? `${s.displayName}: edits via Coleaf`;
  try {
    res.json(await commitAll(s.workspaceDir, message));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/git/sync", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json(await gitSync(s.workspaceDir, s.displayName));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/git/sync/abort", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json(await abortSync(s.workspaceDir));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/git/sync/continue", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json(await continueSync(s.workspaceDir));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/git/sync/resolve", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const side = req.body?.side;
  if (side !== "mine" && side !== "remote") {
    return res.status(400).json({ error: "side must be 'mine' or 'remote'" });
  }
  try {
    res.json(await resolveConflictWith(s.workspaceDir, side));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/sessions/:id/git/incoming", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json(await gitIncoming(s.workspaceDir));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── Agent (SSE streaming) ────────────────────────────────────────────
app.post("/api/sessions/:id/agent", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const message = req.body?.message;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "missing message" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // When the client closes the SSE connection (e.g. user clicks Stop and the
  // browser aborts the fetch), abort the OpenAI request too so we're not
  // burning tokens for a response no one will read.
  //
  // Do not use req "close" here: for POST requests it can fire after the
  // request body is fully read even while the response stream is still open,
  // which made normal chat sends immediately abort before producing any SSE.
  const controller = new AbortController();
  let clientClosed = false;
  let completed = false;
  const abortForClientClose = () => {
    if (completed) return;
    clientClosed = true;
    controller.abort();
  };
  req.on("aborted", abortForClientClose);
  res.on("close", abortForClientClose);

  try {
    await runAgentTurn({
      session: s,
      userMessage: message,
      res,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (!clientClosed && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err?.message ?? String(err) })}\n\n`);
    }
  } finally {
    completed = true;
    if (!clientClosed && !res.writableEnded && !res.destroyed) res.end();
  }
});

// ─── Compile ───────────────────────────────────────────────────────────
app.post("/api/sessions/:id/compile", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    const result = await compile(s.workspaceDir);
    // Don't ship the absolute path to the client — only ok/log/main
    res.json({
      ok: result.ok,
      mainTex: result.mainTex,
      log: result.log,
      durationMs: result.durationMs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/sessions/:id/pdf", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const last = getLastCompile(s.workspaceDir);
  if (!last?.pdfPath) return res.status(404).json({ error: "no PDF yet — compile first" });
  try {
    const stats = await stat(last.pdfPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", stats.size.toString());
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(last.pdfPath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/sessions/:id/agent/reset", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  resetAgent(s);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT ?? 4000);

// Restore persisted sessions before accepting requests
loadSessionsFromDisk().then((n) => {
  if (n > 0) console.log(`Restored ${n} session(s) from disk`);
  app.listen(PORT, () => {
    console.log(`Coleaf server listening on http://localhost:${PORT}`);
  });
});
