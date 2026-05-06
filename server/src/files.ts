import path from "node:path";
import fs from "node:fs/promises";
import type { FileNode } from "./types.js";

// Files/directories to hide from the file tree
const HIDDEN = new Set([".git", "node_modules", ".DS_Store", ".coleaf-session.json"]);
const DENIED = new Set([".coleaf-session.json"]);

export function safeJoin(workspaceDir: string, relPath: string): string {
  const resolved = path.resolve(workspaceDir, relPath);
  const root = path.resolve(workspaceDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  const normalized = path.relative(root, resolved).split(path.sep).join("/");
  if (DENIED.has(normalized)) {
    throw new Error(`Path is not readable or writable: ${relPath}`);
  }
  return resolved;
}

export async function listTree(workspaceDir: string): Promise<FileNode[]> {
  return walk(workspaceDir, "");
}

async function walk(workspaceDir: string, relDir: string): Promise<FileNode[]> {
  const abs = safeJoin(workspaceDir, relDir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRel,
        type: "dir",
        children: await walk(workspaceDir, childRel),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: childRel, type: "file" });
    }
  }
  // Directories first, then files; alphabetical within each
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function readFile(workspaceDir: string, relPath: string): Promise<string> {
  const abs = safeJoin(workspaceDir, relPath);
  return await fs.readFile(abs, "utf-8");
}

export async function writeFile(
  workspaceDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = safeJoin(workspaceDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

export async function deleteFile(workspaceDir: string, relPath: string): Promise<void> {
  const abs = safeJoin(workspaceDir, relPath);
  await fs.unlink(abs);
}
