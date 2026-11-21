// A model picked in the site chat's composer is saved under these keys, so it
// survives restarts. They're deliberately not the old Dashboard/Agent Studio
// keys (nb_default_provider / nb_default_model): those still hold whatever
// was chosen there, and reading them made a stale cloud pick block the local
// default.
//
// With nothing picked, the chat uses the local AI when it's installed, else
// the first AI the person has a key for, else none (see SiteChatPanel). It
// never shows a model they don't have.
export const CHAT_PROVIDER_KEY = 'nb_site_chat_provider';
export const CHAT_MODEL_KEY = 'nb_site_chat_model';
