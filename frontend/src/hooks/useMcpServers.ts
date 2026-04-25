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
  const [name, setName] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [envVars, setEnvVars] = useState('');
  const [saving, setSaving] = useState(false);

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

  async function addServer() {
    if (!name.trim() || !installCommand.trim()) return;

    setSaving(true);
    try {
      const parsedEnvVars: Record<string, string> = {};
      if (envVars.trim()) {
        for (const line of envVars.split('\n')) {
          const [k, ...rest] = line.split('=');
          if (k?.trim()) parsedEnvVars[k.trim()] = rest.join('=').trim();
        }
      }

      await api.createMcpServer({
        name: name.trim(),
        installCommand: installCommand.trim(),
        envVars: parsedEnvVars,
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
    addServer,
    removeServer,
  };
}