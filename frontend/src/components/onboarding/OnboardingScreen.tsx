import { useStore } from '../../stores/appStore';

interface Props {
  onComplete: () => void;
}

// Other areas of the app, demoted to a single muted line below the primary
// action — worth knowing about, but not the next step for a brand-new user.
const OTHER_AREAS = [
  { name: 'Integrations', note: 'connect apps' },
  { name: 'Templates', note: 'ready-made agents' },
  { name: 'NodeGraph', note: 'see your agents' },
  { name: 'Analytics', note: 'usage and costs' },
];

export function OnboardingScreen({ onComplete }: Props) {
  const setActiveTab = useStore((s) => s.setActiveTab);

  function handleGoToDashboard() {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI) {
      electronAPI.completeOnboarding().catch(console.error);
    }
    setActiveTab('dashboard');
    onComplete();
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-brain-bg text-brain-text px-6 py-10">
      <div className="w-full max-w-md text-center">
        <div className="flex justify-center mb-5">
          <img
            src="/tray-icon.png"
            alt="NodeBrain"
            className="w-14 h-14 rounded-2xl object-contain"
            draggable={false}
          />
        </div>

        <h1 className="text-2xl font-bold mb-2">You're set up.</h1>
        <p className="text-brain-text-dim text-sm mb-6">
          Head to the Dashboard and describe what you want done — NodeBrain will build an agent for it.
        </p>

        <button
          onClick={handleGoToDashboard}
          className="px-6 py-2.5 bg-brain-accent hover:bg-brain-accent-dim rounded-lg text-white text-sm font-medium transition-colors"
        >
          Go to Dashboard
        </button>

        <p className="text-xs text-brain-text-dim/70 mt-6">
          Explore later: {OTHER_AREAS.map(({ name, note }) => `${name} (${note})`).join(' · ')}
        </p>
      </div>
    </div>
  );
}
