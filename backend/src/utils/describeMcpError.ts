// Turns a raw MCP connect/spawn error into one plain-language sentence the user
// can act on. The raw text stays in the logs; it never reaches the UI, since
// "spawn npx ENOENT" or a JSON-RPC code means nothing to the people using this.

const RUNTIME_HINTS: Record<string, string> = {
  npx: 'It needs Node.js installed. Get it from nodejs.org, then restart NodeBrain.',
  'npx.cmd': 'It needs Node.js installed. Get it from nodejs.org, then restart NodeBrain.',
  node: 'It needs Node.js installed. Get it from nodejs.org, then restart NodeBrain.',
  uvx: 'It needs uv (a Python tool) installed. Install uv, then restart NodeBrain.',
  uv: 'It needs uv (a Python tool) installed. Install uv, then restart NodeBrain.',
  python: 'It needs Python installed. Install Python, then restart NodeBrain.',
  python3: 'It needs Python installed. Install Python, then restart NodeBrain.',
};

export function describeMcpError(raw: string): string {
  // A missing executable shows up as "spawn <command> ENOENT" when spawned
  // directly, or — on Windows, where cross-spawn goes through cmd.exe — as cmd's
  // "'<command>' is not recognized…" on the server's stderr. POSIX shells say
  // "<command>: command not found".
  const missing = /spawn\s+(\S+)\s+ENOENT/i.exec(raw)
    ?? /'([^']+)' is not recognized as an internal or external command/i.exec(raw)
    ?? /([\w.-]+): command not found/i.exec(raw);
  if (missing) {
    const program = missing[1].replace(/^.*[\\/]/, '').toLowerCase();
    const hint = RUNTIME_HINTS[program]
      ?? `The program "${program}" it runs with isn't installed on this computer.`;
    return `NodeBrain couldn't start this integration. ${hint}`;
  }
  if (/ENOENT/i.test(raw)) {
    return "NodeBrain couldn't start this integration because a program or file it needs is missing.";
  }
  if (/E404|404 Not Found|not in this registry|could not determine executable/i.test(raw)) {
    return "NodeBrain couldn't download this integration because its package couldn't be found. Check the command for typos.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(raw)) {
    return "NodeBrain couldn't download or reach this integration. Check your internet connection, then try again.";
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "NodeBrain couldn't reach this server. Check that it's running and the address is right.";
  }
  if (/EACCES|EPERM/i.test(raw)) {
    return "NodeBrain doesn't have permission to start this integration.";
  }
  if (/timed out|timeout/i.test(raw)) {
    return 'This integration took too long to start. Try again in a moment.';
  }
  if (/connection closed|exited|SIGTERM|SIGKILL/i.test(raw)) {
    return 'This integration started but stopped right away. Check its settings, then try again.';
  }
  return "NodeBrain couldn't start this integration. Try again, and restart NodeBrain if it keeps happening.";
}
