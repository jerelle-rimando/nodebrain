// The model the site chat uses when the person hasn't picked one: the local
// engine when it's installed, otherwise this cloud model.
export const CLOUD_DEFAULT_PROVIDER = 'groq';
export const CLOUD_DEFAULT_MODEL = 'openai/gpt-oss-120b';

// A pick made in the site chat's composer is saved under these keys, so it
// survives restarts. They're deliberately not the old Dashboard/Agent Studio
// keys (nb_default_provider / nb_default_model): those still hold whatever
// was chosen there, and reading them made a stale cloud pick block the local
// default.
export const CHAT_PROVIDER_KEY = 'nb_site_chat_provider';
export const CHAT_MODEL_KEY = 'nb_site_chat_model';
