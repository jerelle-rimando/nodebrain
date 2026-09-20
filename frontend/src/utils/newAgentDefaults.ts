import { api } from './api';

// Provider/model for agents created without an explicit choice (template
// installs). The backend decides: local engine when available, otherwise the
// first cloud provider with a stored key. The pair below is only a last resort
// for when the backend can't be reached; the backend re-validates any model it
// is handed on create, so a stale value can't be persisted.
export async function getNewAgentDefaults(): Promise<{ provider: string; model: string }> {
  try {
    return await api.getDefaultModel();
  } catch {
    return { provider: 'openai', model: 'gpt-4o-mini' };
  }
}
