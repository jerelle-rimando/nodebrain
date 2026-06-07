import { useState } from 'react';

interface Props {
  provider: string;
  model: string;
  availableModels: Record<string, string[]>;
  onChange: (model: string) => void;
  className?: string;
}

export function ModelSelect({ provider, model, availableModels, onChange, className = '' }: Props) {
  const models = availableModels[provider] ?? [];
  const knownModels = models.includes(model) ? models : [...models, ...(model ? [model] : [])];
  const [customInput, setCustomInput] = useState<string | null>(null);

  function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    if (e.target.value === '__custom__') {
      setCustomInput('');
    } else {
      onChange(e.target.value);
    }
  }

  function commitCustom(val: string) {
    const trimmed = val.trim();
    if (trimmed) onChange(trimmed);
    setCustomInput(null);
  }

  if (customInput !== null) {
    return (
      <input
        autoFocus
        value={customInput}
        onChange={(e) => setCustomInput(e.target.value)}
        onBlur={(e) => commitCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitCustom(customInput);
          if (e.key === 'Escape') setCustomInput(null);
        }}
        className={`text-xs font-mono bg-brain-bg border border-brain-accent rounded px-1.5 py-0.5 text-brain-text focus:outline-none ${className}`}
        placeholder="model id..."
      />
    );
  }

  return (
    <select
      value={model || ''}
      onChange={handleSelect}
      className={`text-xs font-mono bg-brain-bg border border-brain-border rounded px-1.5 py-0.5 text-brain-text cursor-pointer hover:border-brain-accent focus:outline-none ${className}`}
    >
      {knownModels.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
      <option value="__custom__">Other...</option>
    </select>
  );
}
