import fs from 'fs';
import path from 'path';
import type { MCPServer } from './mcpClient';

// Lets the built-in MCP servers run on a machine with no Node.js installed.
//
// The packaged app ships a pinned npm and a node shim folder as extra resources;
// Electron main passes their locations in NODEBRAIN_NPX_CLI and
// NODEBRAIN_NODE_SHIM_DIR. This process is Electron's own binary running with
// ELECTRON_RUN_AS_NODE=1, so process.execPath is a working Node 22 — the same
// trick that runs the backend itself. MCP children inherit ELECTRON_RUN_AS_NODE.
//
// Running bin scripts goes through npm's .cmd shims on Windows, which call a bare
// `node` from PATH. The shim folder provides that `node` (forwarding to
// NODEBRAIN_NODE), but only when the machine has no Node of its own: putting it
// ahead of a real install would silently swap someone's Node 24 for Electron's 22.

const bundledNpxCli = process.env.NODEBRAIN_NPX_CLI;
const nodeShimDir = process.env.NODEBRAIN_NODE_SHIM_DIR;

// The env key Windows uses for PATH isn't always upper case ("Path" is common).
// Writing a second, differently cased key would leave which one wins up to chance.
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
}

function findSystemNode(env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env[pathKey(env)] ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => 'node' + ext.toLowerCase())
    : ['node'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return undefined;
}

// Looked up once: whether Node is installed doesn't change while NodeBrain runs,
// and the installer adds it to PATH for new processes only.
const systemNode = findSystemNode(process.env);

export function describeNodeRuntime(): string {
  if (!bundledNpxCli) return 'system npx (no bundled npm configured)';
  return systemNode
    ? `bundled npm on ${process.execPath}; packages run on system Node at ${systemNode}`
    : `bundled npm on ${process.execPath}; no system Node, packages run on it via the node shim`;
}

// Rewrites a built-in server's `npx`/`node` command to run on the bundled runtime.
// Returns the server unchanged when no bundled npm is configured (plain dev mode).
export function withBundledRuntime(server: MCPServer): MCPServer {
  if (!bundledNpxCli) return server;

  let command: string;
  let args: string[];
  if (server.command === 'npx') {
    command = process.execPath;
    args = [bundledNpxCli, ...server.args];
  } else if (server.command === 'node') {
    command = process.execPath;
    args = server.args;
  } else {
    return server;
  }

  const env: Record<string, string> = {
    ...server.env,
    NODEBRAIN_NODE: process.execPath,
    // The bundled npm is pinned on purpose; don't nag about newer releases.
    npm_config_update_notifier: 'false',
  };
  if (!systemNode && nodeShimDir) {
    const key = pathKey(process.env);
    env[key] = [nodeShimDir, process.env[key]].filter(Boolean).join(path.delimiter);
  }

  return { ...server, command, args, env };
}
