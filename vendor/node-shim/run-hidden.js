// Runs a Node script with windowsHide defaulted on for every child process it
// spawns. Usage: <node> run-hidden.js <script> [args...]
//
// Why: the built-in MCP servers run npm on Electron's binary (NodeBrain.exe),
// which is a GUI-subsystem exe, so Windows gives it no console even when it is
// spawned with windowsHide. When npm then starts `cmd.exe /d /s /c <bin>`
// without windowsHide, cmd has no console to inherit and Windows opens a new,
// visible one (a Windows Terminal window titled "C:\Windows\system32\cmd.exe").
// Defaulting windowsHide on here gives that cmd.exe a hidden console instead,
// and everything below it inherits that. See backend/src/mcp/nodeRuntime.ts.
//
// Must patch before the script loads: npm destructures `spawn` from
// child_process at require time.
'use strict';

const childProcess = require('child_process');
const Module = require('module');
const path = require('path');

function hideByDefault(original) {
  return function (file, args, options) {
    // Same argument shapes child_process accepts: (file, args?, options?).
    if (args != null && !Array.isArray(args) && typeof args === 'object') {
      options = args;
      args = undefined;
    }
    if (options == null || typeof options === 'object') {
      options = { windowsHide: true, ...options };
    }
    return original.call(this, file, args, options);
  };
}

childProcess.spawn = hideByDefault(childProcess.spawn);
childProcess.spawnSync = hideByDefault(childProcess.spawnSync);

const script = process.argv[2];
if (!script) {
  process.stderr.write('run-hidden: no script given\n');
  process.exit(1);
}

// Drop ourselves from argv so the script sees the argv it would have had if
// run directly, then run it as the main module (require.main, ESM and all).
process.argv.splice(1, 2, path.resolve(script));
Module.runMain();
