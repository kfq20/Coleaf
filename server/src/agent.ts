import OpenAI from "openai";
import type { Response } from "express";
import type { Session } from "./types.js";
import { listTree, readFile, writeFile } from "./files.js";
import { commitAll, status as gitStatus } from "./git.js";
import { saveSession } from "./sessions.js";

const SYSTEM_PROMPT = `You are a collaborative LaTeX writing assistant working in a shared Overleaf project.

The user is editing the project in a browser-based editor; you have access to the same workspace via tools.

Guidelines:
- Always inspect the project structure with list_files before making non-trivial changes.
- For LaTeX edits, prefer edit_file (exact string replace) for surgical changes; use write_file only for new files or full rewrites.
- After making edits, commit them with a clear message via git_commit so collaborators can sync.
- Don't push to the remote yourself — the user controls sync from the UI.
- Be concise. Explain what you changed in 1-2 sentences after each edit.`;

// OpenAI Responses API tool definitions. Same six tools as before, just with
// `parameters` instead of `input_schema` and wrapped as `{type:"function"}`.
const TOOLS = [
  {
    type: "function" as const,
    name: "list_files",
    description: "List all files in the project workspace as a tree.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "read_file",
    description: "Read the contents of a file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path, e.g. 'main.tex' or 'sections/intro.tex'.",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "function" as const,
    name: "write_file",
    description:
      "Write a file in the workspace, creating parent directories as needed. Overwrites existing files. Use edit_file for small changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function" as const,
    name: "edit_file",
    description:
      "Replace exactly one occurrence of old_string with new_string in the given file. Fails if old_string is not unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        old_string: {
          type: "string",
          description: "Exact text to replace; must appear exactly once.",
        },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    type: "function" as const,
    name: "git_status",
    description: "Show modified, untracked, and staged files plus ahead/behind counts.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "git_commit",
    description:
      "Stage all changes and commit them locally. Does not push — the user pushes from the UI.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message." },
      },
      required: ["message"],
    },
  },
];

async function executeTool(
  session: Session,
  name: string,
  input: any,
): Promise<{ content: string; is_error: boolean }> {
  try {
    switch (name) {
      case "list_files": {
        const tree = await listTree(session.workspaceDir);
        return { content: JSON.stringify(tree, null, 2), is_error: false };
      }
      case "read_file": {
        const content = await readFile(session.workspaceDir, input.path);
        return { content, is_error: false };
      }
      case "write_file": {
        await writeFile(session.workspaceDir, input.path, input.content);
        return {
          content: `Wrote ${input.path} (${input.content.length} chars)`,
          is_error: false,
        };
      }
      case "edit_file": {
        const current = await readFile(session.workspaceDir, input.path);
        const occurrences = current.split(input.old_string).length - 1;
        if (occurrences === 0) {
          return { content: `old_string not found in ${input.path}`, is_error: true };
        }
        if (occurrences > 1) {
          return {
            content: `old_string appears ${occurrences} times in ${input.path}; provide more surrounding context to disambiguate.`,
            is_error: true,
          };
        }
        const updated = current.replace(input.old_string, input.new_string);
        await writeFile(session.workspaceDir, input.path, updated);
        return { content: `Edited ${input.path}`, is_error: false };
      }
      case "git_status": {
        const s = await gitStatus(session.workspaceDir);
        return { content: JSON.stringify(s, null, 2), is_error: false };
      }
      case "git_commit": {
        const result = await commitAll(session.workspaceDir, input.message);
        return { content: JSON.stringify(result), is_error: !result.committed };
      }
      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err: any) {
    return { content: `Error: ${err?.message ?? String(err)}`, is_error: true };
  }
}

function sseSend(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function runAgentTurn(opts: {
  session: Session;
  userMessage: string;
  res: Response;
  signal?: AbortSignal;
}): Promise<void> {
  const { session, userMessage, res, signal } = opts;

  const client = new OpenAI({
    baseURL: session.anthropicBaseUrl,
    apiKey: session.anthropicAuthToken,
  });

  // Append the new user message to the running history.
  session.responseHistory.push({
    type: "message",
    role: "user",
    content: userMessage,
  });

  const MAX_ITERATIONS = 25;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const pendingToolCalls: { call_id: string; name: string; arguments: string }[] = [];
    // Collect every completed output item so we can append them all to history
    // ourselves. The streamed `response.completed.output` is empty (items only
    // arrive via response.output_item.done in stream mode).
    const outputItems: any[] = [];

    try {
      // The SDK's `timeout` option is unreliable for stream:true on this
      // proxy — when the upstream pool hangs, create() never resolves.
      // Wrap in a hard Promise.race so the user always sees an error in <=20s.
      const TIMEOUT_MS = 20_000;
      const createPromise = client.responses.create(
        {
          model: session.model,
          instructions: SYSTEM_PROMPT,
          input: session.responseHistory,
          tools: TOOLS as any,
          stream: true,
        },
        { signal, maxRetries: 0 },
      );
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Upstream timeout: no response in ${TIMEOUT_MS / 1000}s (proxy is slow or pool is empty)`));
        }, TIMEOUT_MS);
      });
      const stream = (await Promise.race([createPromise, timeoutPromise]).finally(() =>
        clearTimeout(timeoutHandle!),
      )) as AsyncIterable<any>;

      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta": {
            sseSend(res, "text", { delta: event.delta });
            break;
          }
          case "response.output_item.done": {
            const item = event.item;
            if (!item) break;
            outputItems.push(item);
            if (item.type === "function_call") {
              pendingToolCalls.push({
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments ?? "{}",
              });
              let parsedInput: any = {};
              try {
                parsedInput = JSON.parse(item.arguments ?? "{}");
              } catch {
                parsedInput = item.arguments;
              }
              sseSend(res, "tool_use", {
                id: item.call_id,
                name: item.name,
                input: parsedInput,
              });
            }
            break;
          }
          case "response.completed": {
            // Output items in the completed event payload are empty in stream
            // mode — we already collected them above.
            break;
          }
          case "response.failed":
          case "error": {
            const msg =
              event.response?.error?.message ??
              event.error?.message ??
              JSON.stringify(event);
            sseSend(res, "error", { message: msg });
            return;
          }
          // Other events ignored.
        }
      }
      // Append everything we observed in this round to history before either
      // looping for another tool round or wrapping up the turn.
      for (const item of outputItems) session.responseHistory.push(item);
    } catch (err: any) {
      // ONLY treat as "user cancel" when the signal we received is aborted.
      // The SDK's own timeout fires an internal AbortError that isn't the
      // same as the user clicking Stop — surfacing those as silent returns
      // is what made the turn appear to hang forever.
      const isUserAbort = signal?.aborted === true;
      // Drop the orphan user message in either case (no response means no
      // valid context for next turn).
      if (isUserAbort || iter === 0) {
        for (let i = session.responseHistory.length - 1; i >= 0; i--) {
          const m = session.responseHistory[i];
          if (m?.type === "message" && m.role === "user" && m.content === userMessage) {
            session.responseHistory.splice(i, 1);
            break;
          }
        }
      }
      saveSession(session).catch(() => {});
      if (isUserAbort) return; // user clicked Stop — don't surface as error
      // Anything else (SDK timeout, 503, network) → show in chat
      const msg = err?.message ?? String(err);
      const hint =
        /no available accounts|providers unavailable|upstream|timeout|timed out/i.test(msg)
          ? `\n\nThis is usually a proxy-side issue (account pool exhausted, or upstream slow). Try again in a few seconds, or switch baseURL/token via Logout.`
          : "";
      console.error(`[agent ${session.id.slice(0,6)}] error:`, msg);
      sseSend(res, "error", { message: msg + hint });
      return;
    }

    if (pendingToolCalls.length === 0) {
      sseSend(res, "done", { stop_reason: "end_turn" });
      saveSession(session).catch((err) =>
        console.error("saveSession after turn failed", err),
      );
      return;
    }

    // Execute each tool and append outputs to history for the next round.
    for (const tc of pendingToolCalls) {
      let parsedInput: any = {};
      try {
        parsedInput = JSON.parse(tc.arguments);
      } catch {
        parsedInput = {};
      }
      const result = await executeTool(session, tc.name, parsedInput);
      sseSend(res, "tool_result", {
        tool_use_id: tc.call_id,
        content:
          result.content.length > 2000
            ? result.content.slice(0, 2000) + `\n... (${result.content.length} chars truncated)`
            : result.content,
        is_error: result.is_error,
      });
      session.responseHistory.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: result.content,
      });
    }
  }

  sseSend(res, "error", { message: `Hit ${MAX_ITERATIONS}-iteration limit.` });
}

export function resetAgent(session: Session): void {
  session.previousResponseId = undefined;
  session.responseHistory = [];
  session.agentMessages = [];
  saveSession(session).catch((err) =>
    console.error("saveSession after reset failed", err),
  );
}
