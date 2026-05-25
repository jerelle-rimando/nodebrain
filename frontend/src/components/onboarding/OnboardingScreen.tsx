import { Shield, Plug, LayoutTemplate, MessageSquare, GitFork, BarChart3 } from 'lucide-react';

interface Props {
  onComplete: () => void;
}

interface Step {
  number: number;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  name: string;
  description: string;
}

const STEPS: Step[] = [
  {
    number: 1,
    icon: Shield,
    iconColor: 'text-yellow-400',
    iconBg: 'bg-yellow-500/10',
    name: 'Vault',
    description: "Add your AI provider's API key",
  },
  {
    number: 2,
    icon: Plug,
    iconColor: 'text-violet-400',
    iconBg: 'bg-violet-500/10',
    name: 'Integrations',
    description: 'Connect Telegram, GitHub, Slack, and more',
  },
  {
    number: 3,
    icon: LayoutTemplate,
    iconColor: 'text-cyan-400',
    iconBg: 'bg-cyan-500/10',
    name: 'Templates',
    description: 'Browse pre-built agent setups, or skip ahead',
  },
  {
    number: 4,
    icon: MessageSquare,
    iconColor: 'text-brain-accent',
    iconBg: 'bg-brain-accent/10',
    name: 'Dashboard',
    description: 'Chat with NodeBrain to create your first agent',
  },
  {
    number: 5,
    icon: GitFork,
    iconColor: 'text-green-400',
    iconBg: 'bg-green-500/10',
    name: 'NodeGraph',
    description: 'Visualize, run, and manage your agents',
  },
  {
    number: 6,
    icon: BarChart3,
    iconColor: 'text-rose-400',
    iconBg: 'bg-rose-500/10',
    name: 'Analytics',
    description: 'Track costs, token usage, and task history',
  },
];

export function OnboardingScreen({ onComplete }: Props) {
  function handleComplete() {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI) {
      electronAPI.completeOnboarding().catch(console.error);
    }
    onComplete();
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-brain-bg text-brain-text px-6 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-5">
          <img
            src="/tray-icon.png"
            alt="NodeBrain"
            className="w-14 h-14 rounded-2xl object-contain"
            draggable={false}
          />
        </div>

        <h1 className="text-2xl font-bold text-center mb-2">Welcome to NodeBrain!</h1>
        <p className="text-brain-text-dim text-sm text-center mb-7">Here's how to get started:</p>

        <ol className="space-y-2.5 mb-7">
          {STEPS.map(({ number, icon: Icon, iconColor, iconBg, name, description }) => (
            <li
              key={number}
              className="flex items-center gap-3 rounded-xl border border-brain-border bg-brain-surface p-3"
            >
              <span className="text-xs font-mono text-brain-text-dim flex-shrink-0 w-5 text-center">
                {number}.
              </span>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                <Icon size={18} className={iconColor} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-brain-text leading-tight">{name}</div>
                <div className="text-xs text-brain-text-dim leading-snug mt-0.5">{description}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex justify-center">
          <button
            onClick={handleComplete}
            className="px-6 py-2.5 bg-brain-accent hover:bg-brain-accent-dim rounded-lg text-white text-sm font-medium transition-colors"
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  );
}
