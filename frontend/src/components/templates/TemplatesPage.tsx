import { useState, useRef } from 'react';
import {
  LayoutTemplate, Plus, Trash2, Bot, Upload, X, CheckCircle,
  Loader2, Users, Puzzle, FileJson, Download,
} from 'lucide-react';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { featuredTemplates, type FeaturedTemplate } from '../../data/featuredTemplates';
import { toast } from '../shared/Toast';
import type { Agent } from '@shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TemplateAgentEntry {
  name: string;
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  schedule?: string;
  toolPermissions?: string[];
}

interface TemplateConnection {
  sourceName: string;
  targetName: string;
}

interface AgentTemplate {
  id: string;
  version?: string;
  name: string;
  description: string;
  tags?: string[];
  agents?: TemplateAgentEntry[];
  connections?: TemplateConnection[];
  // legacy single-agent fields
  systemPrompt?: string;
  provider?: string;
  model?: string;
  schedule?: string;
  toolPermissions?: string[];
  config?: { temperature?: number; maxTokens?: number };
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

const STORAGE_KEY = 'nodebrain_my_templates';

function loadMyTemplates(): AgentTemplate[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as AgentTemplate[];
  } catch {
    return [];
  }
}

function saveMyTemplates(templates: AgentTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateImport(obj: unknown): obj is { version: string; name: string; agents: TemplateAgentEntry[]; connections: TemplateConnection[] } {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return typeof t.version === 'string' && typeof t.name === 'string' && Array.isArray(t.agents) && Array.isArray(t.connections);
}

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const TAG_COLORS: Record<string, string> = {
  research: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  productivity: 'bg-green-500/10 text-green-400 border-green-500/30',
  automation: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  scheduled: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  devops: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  files: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  communication: 'bg-pink-500/10 text-pink-400 border-pink-500/30',
  gmail: 'bg-red-500/10 text-red-400 border-red-500/30',
  calendar: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
  slack: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  development: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
};

const INTEGRATION_COLORS: Record<string, string> = {
  Gmail: 'bg-red-500/10 text-red-400 border-red-500/30',
  'Google Calendar': 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  GitHub: 'bg-gray-500/10 text-gray-300 border-gray-500/30',
  Slack: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  Filesystem: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  'Brave Search': 'bg-violet-500/10 text-violet-400 border-violet-500/30',
};

const REQUIRED_INTEGRATIONS: Record<string, string[]> = {
  'Morning Briefing Team': ['Google Calendar', 'Gmail'],
  'GitHub PR Watcher': ['GitHub', 'Slack'],
  'File Manager Team': ['Filesystem'],
  'Daily Standup': ['Slack'],
  'Research Assistant': ['Brave Search', 'Filesystem'],
};

// ─── Create-from-agents modal ─────────────────────────────────────────────────

interface CreateModalProps {
  agents: Agent[];
  onClose: () => void;
  onSave: (template: AgentTemplate) => void;
}

function CreateTemplateModal({ agents, onClose, onSave }: CreateModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleGenerate() {
    if (!name.trim() || selectedIds.size === 0) return;
    setGenerating(true);
    try {
      const selected = agents.filter((a) => selectedIds.has(a.id));
      const selectedIdSet = new Set(selected.map((a) => a.id));

      const allConnections = await api.getAgentConnections();
      const relevant = allConnections.filter(
        (c) => selectedIdSet.has(c.sourceAgentId) && selectedIdSet.has(c.targetAgentId),
      );

      const idToName = new Map(selected.map((a) => [a.id, a.name]));

      const templateAgents: TemplateAgentEntry[] = selected.map((a) => ({
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        provider: a.provider,
        model: a.model,
        schedule: a.schedule,
        toolPermissions: a.toolPermissions,
      }));

      const connections: TemplateConnection[] = relevant
        .map((c) => ({
          sourceName: idToName.get(c.sourceAgentId)!,
          targetName: idToName.get(c.targetAgentId)!,
        }))
        .filter((c) => c.sourceName && c.targetName);

      const template: AgentTemplate = {
        id: `my-${Date.now()}`,
        version: '1',
        name: name.trim(),
        description: description.trim(),
        agents: templateAgents,
        connections,
        tags: [],
      };

      onSave(template);
      downloadJson(`${name.trim().toLowerCase().replace(/\s+/g, '-')}-template.json`, template);
      toast.success(`Template "${name.trim()}" saved and downloaded.`);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error('Failed to generate template.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-brain-surface border border-brain-border rounded-xl shadow-2xl flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brain-border flex-shrink-0">
          <Bot size={15} className="text-brain-accent" />
          <p className="text-sm font-semibold text-brain-text flex-1">Create template from agents</p>
          <button onClick={onClose} className="text-brain-text-dim hover:text-brain-text transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Agent checklist */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">
              Select agents ({selectedIds.size} selected)
            </p>
            {agents.length === 0 ? (
              <p className="text-xs text-brain-text-dim py-2">No agents available.</p>
            ) : (
              agents.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-brain-border bg-brain-bg hover:border-brain-muted cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(a.id)}
                    onChange={() => toggle(a.id)}
                    className="accent-brain-accent"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-brain-text truncate">{a.name}</p>
                    <p className="text-xs text-brain-text-dim truncate">{a.description || a.model}</p>
                  </div>
                </label>
              ))
            )}
          </div>

          {/* Name */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">Template name</p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Agent Team"
              className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-xs text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent"
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">Description</p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this template do?"
              rows={2}
              className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-xs text-brain-text placeholder-brain-text-dim resize-none focus:outline-none focus:border-brain-accent"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-brain-border flex-shrink-0">
          <button
            onClick={handleGenerate}
            disabled={!name.trim() || selectedIds.size === 0 || generating}
            className="w-full flex items-center justify-center gap-2 py-2 text-xs bg-brain-accent-deep hover:bg-brain-accent-deep-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {generating ? (
              <><Loader2 size={11} className="animate-spin" /> Generating…</>
            ) : (
              <><Download size={11} /> Generate & Download</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Featured template card ───────────────────────────────────────────────────

interface FeaturedCardProps {
  template: FeaturedTemplate;
  onInstall: (t: FeaturedTemplate) => void;
  installing: boolean;
  installed: boolean;
}

function FeaturedTemplateCard({ template, onInstall, installing, installed }: FeaturedCardProps) {
  const integrations = REQUIRED_INTEGRATIONS[template.name] ?? [];
  return (
    <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex flex-col gap-3 hover:border-brain-muted transition-colors">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-brain-bg border border-brain-border flex items-center justify-center flex-shrink-0 text-lg">
          {template.icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-brain-text truncate">{template.name}</p>
          <p className="text-xs text-brain-text-dim leading-relaxed mt-0.5 line-clamp-2">{template.description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-brain-text-dim">
        <span className="flex items-center gap-1"><Users size={10} />{template.agents.length} agent{template.agents.length !== 1 ? 's' : ''}</span>
        <span className="w-1 h-1 rounded-full bg-brain-border" />
        <span className="capitalize">{template.category}</span>
      </div>
      {integrations.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs text-brain-text-dim">
            <Puzzle size={10} /><span>Requires</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {integrations.map((n) => (
              <span key={n} className={`text-xs px-1.5 py-0.5 rounded border font-medium ${INTEGRATION_COLORS[n] ?? 'bg-brain-bg text-brain-text-dim border-brain-border'}`}>
                {n}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="mt-auto pt-2 border-t border-brain-border">
        <button
          onClick={() => onInstall(template)}
          disabled={installing || installed}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs bg-brain-accent-deep hover:bg-brain-accent-deep-dim disabled:opacity-60 text-white rounded-lg transition-colors"
        >
          {installing ? <><Loader2 size={11} className="animate-spin" />Installing…</> :
           installed  ? <><CheckCircle size={11} />Installed</> :
                        <><Plus size={11} />Install</>}
        </button>
      </div>
    </div>
  );
}

// ─── My Templates card ────────────────────────────────────────────────────────

interface TemplateCardProps {
  template: AgentTemplate;
  onInstall: (t: AgentTemplate) => void;
  onDelete: (id: string) => void;
  installed: boolean;
}

function TemplateCard({ template, onInstall, onDelete, installed }: TemplateCardProps) {
  const isMulti = Array.isArray(template.agents) && template.agents.length > 0;

  function handleDownload() {
    const { id: _id, ...exportable } = template;
    downloadJson(`${template.name.toLowerCase().replace(/\s+/g, '-')}-template.json`, exportable);
  }

  return (
    <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex flex-col gap-3 hover:border-brain-muted transition-colors">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center flex-shrink-0">
          <Bot size={15} className="text-brain-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-brain-text truncate">{template.name}</p>
          <p className="text-xs text-brain-text-dim leading-relaxed mt-0.5 line-clamp-2">{template.description}</p>
        </div>
        <button
          onClick={() => onDelete(template.id)}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-brain-text-dim hover:text-brain-error hover:bg-brain-error/10 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(template.tags ?? []).map((tag) => (
          <span key={tag} className={`text-xs px-1.5 py-0.5 rounded border font-medium ${TAG_COLORS[tag] ?? 'bg-brain-bg text-brain-text-dim border-brain-border'}`}>
            {tag}
          </span>
        ))}
        {isMulti && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border bg-brain-bg text-brain-text-dim border-brain-border">
            <Users size={9} />{template.agents!.length} agents
          </span>
        )}
        {template.version && (
          <span className="text-xs px-1.5 py-0.5 rounded border bg-brain-bg text-brain-text-dim border-brain-border font-mono">
            v{template.version}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 mt-auto pt-1 border-t border-brain-border">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-muted rounded-lg transition-colors"
        >
          <Download size={11} /> Download
        </button>
        <button
          onClick={() => onInstall(template)}
          disabled={installed}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs bg-brain-accent-deep hover:bg-brain-accent-deep-dim disabled:opacity-60 text-white rounded-lg transition-colors"
        >
          {installed ? <><CheckCircle size={11} />Installed</> : <><Plus size={11} />Install</>}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TemplatesPage() {
  const { agents } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [installingName, setInstallingName] = useState<string | null>(null);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());

  const [myTemplates, setMyTemplates] = useState<AgentTemplate[]>(loadMyTemplates);
  const [installedMyIds, setInstalledMyIds] = useState<Set<string>>(new Set());

  const [showCreateModal, setShowCreateModal] = useState(false);

  // ── Featured install ──────────────────────────────────────────────────────

  async function handleInstall(template: FeaturedTemplate) {
    setInstallingName(template.name);
    try {
      const nameToId = new Map<string, string>();
      for (const agentDef of template.agents) {
        const created = await api.createAgent({
          name: agentDef.name,
          description: agentDef.description,
          systemPrompt: agentDef.systemPrompt,
          provider: 'openai',
          model: 'gpt-4o-mini',
          schedule: agentDef.schedule,
          toolPermissions: [],
          config: {},
        });
        nameToId.set(agentDef.name, created.id);
      }
      for (const agentDef of template.agents) {
        if (!agentDef.connectsTo?.length) continue;
        const sourceId = nameToId.get(agentDef.name);
        if (!sourceId) continue;
        for (const targetName of agentDef.connectsTo) {
          const targetId = nameToId.get(targetName);
          if (targetId) await api.createAgentConnection(sourceId, targetId);
        }
      }
      setInstalledNames((prev) => new Set(prev).add(template.name));
      toast.success(`Template installed: ${template.agents.length} agents created.`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to install template.');
    } finally {
      setInstallingName(null);
    }
  }

  // ── My Templates: use ─────────────────────────────────────────────────────

  async function handleUse(template: AgentTemplate) {
    try {
      if (Array.isArray(template.agents) && template.agents.length > 0) {
        const nameToId = new Map<string, string>();
        for (const a of template.agents) {
          const created = await api.createAgent({
            name: a.name,
            description: a.description,
            systemPrompt: a.systemPrompt,
            provider: (a.provider ?? 'openai') as any,
            model: a.model ?? 'gpt-4o-mini',
            schedule: a.schedule,
            toolPermissions: a.toolPermissions ?? [],
            config: {},
          });
          nameToId.set(a.name, created.id);
        }
        for (const conn of template.connections ?? []) {
          const sourceId = nameToId.get(conn.sourceName);
          const targetId = nameToId.get(conn.targetName);
          if (sourceId && targetId) await api.createAgentConnection(sourceId, targetId);
        }
        toast.success(`Installed: ${template.agents.length} agents created.`);
      } else {
        await api.createAgent({
          name: template.name,
          description: template.description,
          systemPrompt: template.systemPrompt ?? '',
          provider: (template.provider ?? 'openai') as any,
          model: template.model ?? 'gpt-4o-mini',
          schedule: template.schedule,
          toolPermissions: template.toolPermissions ?? [],
          config: template.config ?? {},
        });
      }
      setInstalledMyIds((prev) => new Set(prev).add(template.id));
    } catch (err) {
      console.error(err);
      toast.error('Failed to use template.');
    }
  }

  // ── My Templates: delete ──────────────────────────────────────────────────

  function handleDelete(id: string) {
    const updated = myTemplates.filter((t) => t.id !== id);
    setMyTemplates(updated);
    saveMyTemplates(updated);
  }

  // ── My Templates: import from file ────────────────────────────────────────

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed: unknown = JSON.parse(evt.target?.result as string);
        if (!validateImport(parsed)) {
          toast.error('Invalid template file. Must include version, name, and agents array.');
          return;
        }
        const template: AgentTemplate = {
          id: `my-${Date.now()}`,
          version: parsed.version,
          name: parsed.name,
          description: (parsed as any).description ?? '',
          agents: parsed.agents,
          connections: parsed.connections,
          tags: (parsed as any).tags ?? [],
        };
        const updated = [template, ...myTemplates];
        setMyTemplates(updated);
        saveMyTemplates(updated);
        toast.success(`Template "${parsed.name}" imported.`);
      } catch {
        toast.error('Could not parse JSON file.');
      }
    };
    reader.readAsText(file);
  }

  // ── My Templates: save from create modal ──────────────────────────────────

  function handleSaveCreated(template: AgentTemplate) {
    const updated = [template, ...myTemplates];
    setMyTemplates(updated);
    saveMyTemplates(updated);
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileImport}
      />

      {/* Create-from-agents modal */}
      {showCreateModal && (
        <CreateTemplateModal
          agents={agents}
          onClose={() => setShowCreateModal(false)}
          onSave={handleSaveCreated}
        />
      )}

      {/* Featured */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <LayoutTemplate size={16} className="text-brain-accent" />
          <h2 className="text-sm font-semibold text-brain-text">Featured</h2>
          <span className="text-xs text-brain-text-dim font-mono ml-1">{featuredTemplates.length} templates</span>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {featuredTemplates.map((t) => (
            <FeaturedTemplateCard
              key={t.name}
              template={t}
              onInstall={handleInstall}
              installing={installingName === t.name}
              installed={installedNames.has(t.name)}
            />
          ))}
        </div>
      </section>

      {/* My Templates */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-brain-text">My Templates</h2>
          <span className="text-xs text-brain-text-dim font-mono ml-1">{myTemplates.length} saved</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-muted rounded-lg transition-colors"
            >
              <FileJson size={11} /> Import from file
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-muted rounded-lg transition-colors"
            >
              <Upload size={11} /> Create from current agents
            </button>
          </div>
        </div>

        {myTemplates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-brain-border p-10 flex flex-col items-center gap-2 text-brain-text-dim">
            <LayoutTemplate size={24} className="opacity-30" />
            <p className="text-xs">No saved templates yet. Import a file or create one from your agents.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {myTemplates.map((t) => (
              <TemplateCard key={t.id} template={t} onInstall={handleUse} onDelete={handleDelete} installed={installedMyIds.has(t.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
