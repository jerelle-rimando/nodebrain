// The model the chat boxes use until the person picks one. The choice is
// shared: Agent Studio (on the NodeGraph) and the site chat read and write the
// same keys, so picking a model in one picks it in both.
export const CLOUD_DEFAULT_PROVIDER = 'groq';
export const CLOUD_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const CHAT_PROVIDER_KEY = 'nb_default_provider';
export const CHAT_MODEL_KEY = 'nb_default_model';
