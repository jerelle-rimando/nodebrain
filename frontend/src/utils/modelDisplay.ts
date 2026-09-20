// Display-only friendly names, keyed by raw model id. The raw id is still what
// gets sent to the backend and persisted — this map only changes what's shown.
// Add entries as more models get friendly labels; unmapped ids fall back to the
// raw id via displayModelName(). Use it anywhere a model is rendered to the
// user; never for values that are stored, sent, or exported.
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'qwen3:4b-instruct-2507-q4_K_M': 'Qwen 3 4B · Local',
};

export function displayModelName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}
