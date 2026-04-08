import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { toast } from '../components/shared/Toast';

export interface CustomMCPServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  createdAt: string;
}

export function useMcpServers() {
  const [customServers, setCustomServers] = useState<CustomMCPServer[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envVars, setEnvVars] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getMcpServers()
      .then(setCustomServers)
      .catch(console.error);
  }, []);

  function resetForm() {
    setName('');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnvVars('');
    setShowAddForm(false);
    setTransport('stdio');
  }

  async function addServer() {
    if (!name.trim()) return;
    if (transport === 'stdio' && !command.trim()) return;
    if (transport === 'sse' && !url.trim()) return;

    setSaving(true);
    try {
      const parsedEnvVars: Record<string, string> = {};
      if (envVars.trim()) {
        for (const line of envVars.split('\n')) {
          const [k, ...rest] = line.split('=');
          if (k?.trim()) parsedEnvVars[k.trim()] = rest.join('=').trim();
        }
      }

      const payload = transport === 'stdio'
        ? {
            name: name.trim(),
            transport: 'stdio' as const,
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
            envVars: parsedEnvVars,
          }
        : {
            name: name.trim(),
            transport: 'sse' as const,
            url: url.trim(),
            envVars: parsedEnvVars,
          };

      await api.createMcpServer(payload);
      const updated = await api.getMcpServers();
      setCustomServers(updated);
      resetForm();
      toast.success('MCP server connected');
    } catch {
      toast.error('Failed to connect MCP server');
    } finally {
      setSaving(false);
    }
  }

  async function removeServer(id: string) {
    try {
      await api.deleteMcpServer(id);
      setCustomServers(prev => prev.filter(s => s.id !== id));
      toast.success('MCP server removed');
    } catch {
      toast.error('Failed to remove MCP server');
    }
  }

  return {
    customServers,
    showAddForm, setShowAddForm,
    transport, setTransport,
    name, setName,
    command, setCommand,
    args, setArgs,
    url, setUrl,
    envVars, setEnvVars,
    saving,
    addServer,
    removeServer,
  };
}