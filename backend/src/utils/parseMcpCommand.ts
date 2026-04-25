export interface ParsedMCPCommand {
    transport: 'stdio' | 'sse';
    command?: string;
    args: string[];
    url?: string;
  }
  
  export function parseMcpInstallCommand(input: string): ParsedMCPCommand {
    const trimmed = input.trim();
  
    // SSE/HTTP transport — starts with http:// or https://
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return {
        transport: 'sse',
        args: [],
        url: trimmed,
      };
    }
  
    // npx command — most common format from MCP marketplaces
    if (trimmed.startsWith('npx')) {
      const parts = splitCommand(trimmed);
      return {
        transport: 'stdio',
        command: 'npx',
        args: parts.slice(1),
      };
    }
  
    // uvx command — Python MCP servers
    if (trimmed.startsWith('uvx')) {
      const parts = splitCommand(trimmed);
      return {
        transport: 'stdio',
        command: 'uvx',
        args: parts.slice(1),
      };
    }
  
    // node command
    if (trimmed.startsWith('node ')) {
      const parts = splitCommand(trimmed);
      return {
        transport: 'stdio',
        command: 'node',
        args: parts.slice(1),
      };
    }
  
    // Plain package name — @scope/package or package-name
    // Treat as npx -y <package>
    if (trimmed.startsWith('@') || /^[a-z0-9-]+$/i.test(trimmed.split(' ')[0])) {
      return {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', ...splitCommand(trimmed)],
      };
    }
  
    // Fallback — treat entire input as a command
    const parts = splitCommand(trimmed);
    return {
      transport: 'stdio',
      command: parts[0],
      args: parts.slice(1),
    };
  }
  
  // Splits a command string respecting quoted strings
  function splitCommand(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
  
    for (const char of input) {
      if (inQuote) {
        if (char === quoteChar) {
          inQuote = false;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === ' ') {
        if (current.length > 0) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
  
    if (current.length > 0) {
      parts.push(current);
    }
  
    return parts;
  }