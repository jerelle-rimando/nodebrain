import { useState, useEffect } from 'react';
import type { McpAccessWarning } from '@shared/types';
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
  accessWarning?: McpAccessWarning | null;
}

export function useMcpServers() {
  const [customServers, setCustomServers] = useState<CustomMCPServer[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [envVars, setEnvVars] = useState('');
  const [saving, setSaving] = useState(false);
  // Set when the command reaches broadly into the disk; the add waits on the
  // user's confirm. Never blocks — confirming always proceeds.
  const [pendingWarning, setPendingWarning] = useState<McpAccessWarning | null>(null);

  useEffect(() => {
    api.getMcpServers()
      .then(setCustomServers)
      .catch(console.error);
  }, []);

  function resetForm() {
    setName('');
    setInstallCommand('');
    setEnvVars('');
    setShowAdvanced(false);
    setShowAddForm(false);
  }

  function parseEnvVars(): Record<string, string> {
    const parsedEnvVars: Record<string, string> = {};
    if (envVars.trim()) {
      for (const line of envVars.split('\n')) {
        const [k, ...rest] = line.split('=');
        if (k?.trim()) parsedEnvVars[k.trim()] = rest.join('=').trim();
      }
    }
    return parsedEnvVars;
  }

  async function addServer() {
    if (!name.trim() || !installCommand.trim()) return;

    setSaving(true);
    try {
      const { accessWarning } = await api.assessMcpServer({
        installCommand: installCommand.trim(),
        envVars: parseEnvVars(),
      });
      if (accessWarning) {
        setPendingWarning(accessWarning);
        setSaving(false);
        return;
      }
    } catch (err) {
      // The check is advisory. If it can't run, add anyway — the backend still
      // assesses on save, so the card badge appears either way.
      console.error(err);
    }
    await createServer();
  }

  async function confirmAddServer() {
    setPendingWarning(null);
    await createServer();
  }

  function cancelAddServer() {
    setPendingWarning(null);
  }

  async function createServer() {
    setSaving(true);
    try {
      await api.createMcpServer({
        name: name.trim(),
        installCommand: installCommand.trim(),
        envVars: parseEnvVars(),
      });

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
    name, setName,
    installCommand, setInstallCommand,
    showAdvanced, setShowAdvanced,
    envVars, setEnvVars,
    saving,
    pendingWarning,
    addServer,
    confirmAddServer,
    cancelAddServer,
    removeServer,
  };
}
