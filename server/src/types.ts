export type Session = {
  id: string;
  displayName: string;
  workspaceDir: string;
  gitUrl: string; // git URL with token embedded
  // Field names kept as `anthropic*` for backwards-compat with existing
  // session files; the values now feed an OpenAI-compatible Responses API
  // client (e.g. https://api.openai.com/v1 or a compatible proxy).
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  model: string;
  createdAt: number;
  // Multi-turn continuity via OpenAI Responses API server-side state.
  // (Some proxies don't support this — see responseHistory below.)
  previousResponseId?: string;
  // Client-side conversation history when previous_response_id isn't
  // available. Each entry is a Responses API input/output item:
  // {type:"message",...} | {type:"function_call",...} |
  // {type:"function_call_output",...} | {type:"reasoning",...} | etc.
  responseHistory: any[];
  // Legacy: Anthropic content-block conversation history. Unused with the
  // Responses API path but kept on the type so old session files still parse.
  agentMessages: AgentMessage[];
};

export type AgentMessage = {
  role: "user" | "assistant";
  content: any; // Anthropic content blocks
};

export type FileNode = {
  name: string;
  path: string; // relative to workspace
  type: "file" | "dir";
  children?: FileNode[];
};
