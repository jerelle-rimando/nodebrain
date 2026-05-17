import { Bot } from 'lucide-react';

interface Props {
  onComplete: () => void;
}

export function OnboardingScreen({ onComplete }: Props) {
  function handleComplete() {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI) {
      electronAPI.completeOnboarding().catch(console.error);
    }
    onComplete();
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-brain-bg text-brain-text">
      <div className="w-14 h-14 rounded-2xl bg-brain-accent flex items-center justify-center mb-6">
        <Bot size={28} className="text-white" />
      </div>
      <h1 className="text-2xl font-bold mb-2">Welcome to NodeBrain</h1>
      <p className="text-brain-text-dim text-sm mb-8">Create your first agent to get started.</p>
      <button
        onClick={handleComplete}
        className="px-6 py-2.5 bg-brain-accent hover:bg-brain-accent-dim rounded-lg text-white text-sm font-medium transition-colors"
      >
        Get Started
      </button>
    </div>
  );
}
