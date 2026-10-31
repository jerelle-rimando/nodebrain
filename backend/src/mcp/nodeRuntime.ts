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

// process.env lookups are case-insensitive on Windows, so PATH finds "Path" too.
function findSystemNode(env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
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

  // Both branches go through run-hidden.js on Windows. Since 5a77b71 moved the
  // built-ins onto bundled Node, the top of the spawn chain is NodeBrain.exe —
  // a GUI-subsystem exe that never gets a console, hidden or otherwise. Before,
  // it was cmd.exe (via cross-spawn), which got a hidden console from the MCP
  // SDK's windowsHide and passed it down. Now the cmd.exe that npm spawns for
  // the package bin has nothing to inherit, and without windowsHide Windows
  // opens a visible terminal window for it. The launcher defaults windowsHide
  // on for everything npm (or the script) spawns.
  const launcher = process.platform === 'win32' && nodeShimDir
    ? [path.join(nodeShimDir, 'run-hidden.js')]
    : [];

  let command: string;
  let args: string[];
  if (server.command === 'npx') {
    command = process.execPath;
    args = [...launcher, bundledNpxCli, ...server.args];
  } else if (server.command === 'node') {
    // The launcher takes the script as its first argument, so this assumes
    // args start with the script rather than node flags.
    command = process.execPath;
    args = [...launcher, ...server.args];
  } else {
    return server;
  }

  const env: Record<string, string> = {
    ...server.env,
    NODEBRAIN_NODE: process.execPath,
    // The bundled npm is pinned on purpose; don't nag about newer releases.
    npm_config_update_notifier: 'false',
  };
  // Always upper-case: connectToServer collapses every PATH casing into PATH,
  // with the server's value winning over ours and the MCP SDK's.
  if (!systemNode && nodeShimDir) {
    env.PATH = [nodeShimDir, process.env.PATH].filter(Boolean).join(path.delimiter);
  }

  return { ...server, command, args, env };
}
