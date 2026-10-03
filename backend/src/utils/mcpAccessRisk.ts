import * as os from 'os';
import * as path from 'path';
import type { McpAccessFinding, McpAccessTier, McpAccessWarning } from '../../shared-types';

// Flags custom MCP server configs that point at broad parts of the disk, so the
// UI can ask for informed consent. This is a heuristic for honest configs, not
// enforcement: any stdio server runs with the user's full permissions whatever
// its args say, and junctions, 8.3 short names, or a server's own config file
// all slip past it. Never use the result to block or alter a server.
//
// To add a pattern: append to PATH_RULES (a path that resolves somewhere broad)
// or FILESYSTEM_SERVER_PATTERNS (a package whose positional args are folders).

export interface McpServerLaunchConfig {
  transport: 'stdio' | 'sse';
  command?: string;
  args: string[];
  envVars: Record<string, string>;
}

// Broadest first. A warning's tier is the broadest of its findings.
const TIER_ORDER: McpAccessTier[] = ['system', 'profile', 'unscoped'];

// Servers whose positional args after the package name are the folders they may
// read and write.
const FILESYSTEM_SERVER_PATTERNS: RegExp[] = [/server-filesystem/i];

interface PathContext {
  home: string;
  // Parent of the home folder (C:\Users, /Users, /home), or null when that is a
  // drive root (e.g. home is /root) and so says nothing about other profiles.
  usersDir: string | null;
  systemDirs: string[];
}

interface PathRule {
  tier: McpAccessTier;
  // Returns a plain-language description of what is reachable, or null.
  describe: (p: string, ctx: PathContext) => string | null;
}

// Checked in order; the first match wins for a given path.
const PATH_RULES: PathRule[] = [
  {
    tier: 'system',
    describe: (p) => {
      if (!isRoot(p)) return null;
      return p === path.sep || p === '/'
        ? 'Every file on this computer.'
        : `Every file and folder on the ${p} drive.`;
    },
  },
  {
    tier: 'system',
    describe: (p, ctx) => {
      const dir = ctx.systemDirs.find((d) => isSameOrInside(p, d));
      return dir ? `System files in ${dir}. Changing these can stop programs or the operating system from working.` : null;
    },
  },
  {
    tier: 'system',
    describe: (p, ctx) =>
      ctx.usersDir && isSame(p, ctx.usersDir) ? `Every user's folder on this computer (${p}).` : null,
  },
  {
    tier: 'profile',
    describe: (p, ctx) =>
      isSame(p, ctx.home)
        ? `Could read or change anything in your user folder (${p}), including documents, downloads, and saved app data.`
        : null,
  },
  {
    tier: 'profile',
    describe: (p, ctx) =>
      ctx.usersDir && isSame(path.dirname(p), ctx.usersDir)
        ? `Could read or change anything in the user folder ${p}.`
        : null,
  },
];

export function assessMcpServerAccess(config: McpServerLaunchConfig): McpAccessWarning | null {
  if (config.transport !== 'stdio') return null;

  const ctx = buildContext();
  const findings: McpAccessFinding[] = [];

  for (const raw of pathLikeValues(config)) {
    const finding = classifyPath(resolvePath(raw), ctx);
    if (finding) findings.push(finding);
  }

  findings.push(...assessFilesystemServerArgs(config, ctx));

  return buildWarning(findings);
}

function assessFilesystemServerArgs(config: McpServerLaunchConfig, ctx: PathContext): McpAccessFinding[] {
  const tokens = [config.command ?? '', ...config.args];
  const pkgIndex = tokens.findIndex((t) => FILESYSTEM_SERVER_PATTERNS.some((re) => re.test(t)));
  if (pkgIndex === -1) return [];

  const folders = tokens.slice(pkgIndex + 1).filter((t) => !t.startsWith('-'));
  if (folders.length === 0) {
    // The current server-filesystem refuses to run without a folder (NodeBrain
    // doesn't offer MCP roots); older or forked versions may behave differently.
    return [{
      tier: 'unscoped',
      description: 'No folder was given, so it is unclear which files this server will use. Add the folder you want agents to work in to the end of the command.',
    }];
  }

  // Absolute folders were already classified above. Relative ones resolve
  // against NodeBrain's own working folder, which is rarely what was meant.
  const findings: McpAccessFinding[] = [];
  for (const folder of folders.filter((f) => !isPathLike(f))) {
    const resolved = path.resolve(folder);
    findings.push(
      classifyPath(resolved, ctx) ?? {
        tier: 'unscoped',
        path: resolved,
        description: `"${folder}" is a relative path, so it points inside NodeBrain's own working folder (${resolved}), which is probably not the folder you meant.`,
      },
    );
  }
  return findings;
}

function classifyPath(p: string, ctx: PathContext): McpAccessFinding | null {
  for (const rule of PATH_RULES) {
    const description = rule.describe(p, ctx);
    if (description) return { tier: rule.tier, path: p, description };
  }
  return null;
}

function buildWarning(findings: McpAccessFinding[]): McpAccessWarning | null {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.tier}|${f.path ? pathKey(f.path) : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;

  unique.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  return { tier: unique[0].tier, findings: unique };
}

function buildContext(): PathContext {
  const home = path.resolve(os.homedir());
  const parent = path.dirname(home);
  const env = process.env;
  const systemDirs =
    process.platform === 'win32'
      ? [
          env.SystemRoot ?? 'C:\\Windows',
          env.ProgramFiles ?? 'C:\\Program Files',
          env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          env.ProgramData ?? 'C:\\ProgramData',
        ]
      : ['/bin', '/etc', '/sbin', '/usr', '/var', '/System', '/Library'];
  return {
    home,
    usersDir: isRoot(parent) ? null : parent,
    systemDirs: systemDirs.map((d) => path.resolve(d)),
  };
}

// Every arg, the value half of --flag=value, and env var values split on
// list separators — keeping only those that look like absolute paths.
function pathLikeValues(config: McpServerLaunchConfig): string[] {
  const values: string[] = [];
  for (const arg of [config.command ?? '', ...config.args]) {
    const eq = arg.indexOf('=');
    values.push(arg.startsWith('-') && eq !== -1 ? arg.slice(eq + 1) : arg);
  }
  for (const value of Object.values(config.envVars)) {
    values.push(...value.split(/[;,]/));
  }
  return values.map((v) => v.trim()).filter(isPathLike);
}

function isPathLike(value: string): boolean {
  return /^~(?=$|[\\/])/.test(value) || /^[A-Za-z]:/.test(value) || path.isAbsolute(value);
}

// Servers expand a leading ~ themselves; the spawn does not go through a shell,
// so %VAR% and $VAR arrive literally and are not expanded here either.
function resolvePath(raw: string): string {
  const expanded = /^~(?=$|[\\/])/.test(raw) ? os.homedir() + raw.slice(1) : raw;
  return path.resolve(expanded);
}

function isRoot(p: string): boolean {
  return path.parse(p).root === p;
}

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSame(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function isSameOrInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const base = pathKey(parent);
  return c === base || c.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
