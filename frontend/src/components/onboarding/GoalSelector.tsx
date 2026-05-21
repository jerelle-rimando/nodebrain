import { useState } from 'react';
import { Sun, GitPullRequest, FolderOpen, Search, Bot, ArrowRight, Loader2, CheckCircle } from 'lucide-react';
import { api } from '../../utils/api';
import { featuredTemplates } from '../../data/featuredTemplates';
import type { FeaturedTemplate } from '../../data/featuredTemplates';

export interface GoalDoneOptions {
  starterPrompt?: string;
}

interface Props {
  onDone: (options?: GoalDoneOptions) => void;
}

// ─── Goal definitions ─────────────────────────────────────────────────────────

interface Goal {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  templateName?: string;
  starterPrompt?: string;
  skip?: boolean;
}

const GOALS: Goal[] = [
  {
    id: 'daily-briefing',
    title: 'Daily Briefing',
    description: 'Get a personalised morning summary of news and calendar events.',
    icon: Sun,
    iconColor: 'text-yellow-400',
    iconBg: 'bg-yellow-500/10 group-hover:bg-yellow-500/20',
    templateName: 'Morning Briefing Team',
  },
  {
    id: 'code-review',
    title: 'Code Review',
    description: 'Monitor pull requests and notify your team automatically.',
    icon: GitPullRequest,
    iconColor: 'text-violet-400',
    iconBg: 'bg-violet-500/10 group-hover:bg-violet-500/20',
    templateName: 'GitHub PR Watcher',
  },
  {
    id: 'watch-folder',
    title: 'Watch a Folder',
    description: 'Read, summarise, and report on documents in a local folder.',
    icon: FolderOpen,
    iconColor: 'text-cyan-400',
    iconBg: 'bg-cyan-500/10 group-hover:bg-cyan-500/20',
    templateName: 'File Manager Team',
  },
  {
    id: 'research',
    title: 'Research Topics',
    description: 'Search the web and produce a referenced research brief.',
    icon: Search,
    iconColor: 'text-green-400',
    iconBg: 'bg-green-500/10 group-hover:bg-green-500/20',
    templateName: 'Research Assistant',
  },
  {
    id: 'build-own',
    title: 'Build Your Own',
    description: "Describe what you need and we'll configure the agents for you.",
    icon: Bot,
    iconColor: 'text-brain-accent',
    iconBg: 'bg-brain-accent/10 group-hover:bg-brain-accent/20',
    starterPrompt: 'I want an agent that ',
  },
  {
    id: 'skip',
    title: 'Skip for now',
    description: 'Jump straight in and explore at your own pace.',
    icon: ArrowRight,
    iconColor: 'text-brain-text-dim',
    iconBg: 'bg-brain-border group-hover:bg-brain-muted/40',
    skip: true,
  },
];

// ─── Template install logic ───────────────────────────────────────────────────

async function installTemplate(template: FeaturedTemplate): Promise<void> {
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
}

// ─── GoalSelector ─────────────────────────────────────────────────────────────

export function GoalSelector({ onDone }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function finalize(options?: GoalDoneOptions) {
    (window as any).electronAPI?.completeOnboarding?.().catch?.(() => {});
    onDone(options);
  }

  async function handleSelect(goal: Goal) {
    if (loading || done) return;
    setError(null);

    if (goal.skip || goal.starterPrompt !== undefined) {
      finalize(goal.starterPrompt ? { starterPrompt: goal.starterPrompt } : undefined);
      return;
    }

    const template = featuredTemplates.find(t => t.name === goal.templateName);
    if (!template) {
      finalize();
      return;
    }

    setLoading(goal.id);
    try {
      await installTemplate(template);
      setDone(goal.id);
      setTimeout(() => finalize(), 800);
    } catch {
      setError(`Failed to install "${goal.title}". You can install it later from Templates.`);
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-brain-bg px-6 py-12">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-brain-text mb-2">
            What would you like NodeBrain to do for you?
          </h1>
          <p className="text-sm text-brain-text-dim">
            Pick a goal to get started, or skip to explore on your own.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-brain-error/10 border border-brain-error/30 text-brain-error text-xs text-center">
            {error}
          </div>
        )}

        {/* Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {GOALS.map((goal) => {
            const Icon = goal.icon;
            const isLoading = loading === goal.id;
            const isDone = done === goal.id;
            const isDisabled = !!loading || !!done;

            return (
              <button
                key={goal.id}
                onClick={() => handleSelect(goal)}
                disabled={isDisabled}
                className={`group relative flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-all duration-150 ${
                  goal.skip
                    ? 'border-brain-border bg-transparent hover:bg-brain-surface'
                    : 'border-brain-border bg-brain-surface hover:border-brain-accent/40 hover:bg-brain-surface'
                } ${isDisabled && !isLoading && !isDone ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {/* Icon */}
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${goal.iconBg}`}>
                  {isLoading ? (
                    <Loader2 size={18} className={`${goal.iconColor} animate-spin`} />
                  ) : isDone ? (
                    <CheckCircle size={18} className="text-brain-success" />
                  ) : (
                    <Icon size={18} className={goal.iconColor} />
                  )}
                </div>

                {/* Text */}
                <div>
                  <div className={`text-sm font-semibold mb-0.5 ${goal.skip ? 'text-brain-text-dim' : 'text-brain-text'}`}>
                    {goal.title}
                  </div>
                  <div className="text-xs text-brain-text-dim leading-relaxed">
                    {goal.description}
                  </div>
                </div>

                {/* Installing label */}
                {isLoading && (
                  <span className="absolute bottom-3 right-3 text-xs text-brain-text-dim">
                    Installing…
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
