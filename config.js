// Translation Model Configuration
// Change MODEL_CHOICE to switch between AI providers

const MODEL_CHOICE = 'claude-opus';  // Options: 'claude-opus', 'openai-o1', 'gemini-thinking'

const MODEL_CONFIGS = {
  'claude-opus': {
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    maxTokens: 16000,
    temperature: 0.3,
    name: 'Claude Opus 4.5'
  },
  'openai-o1': {
    provider: 'openai',
    model: 'o1',
    maxTokens: 16000,
    temperature: 1, // o1 requires temperature of 1
    name: 'OpenAI o1 (Extended Thinking)'
  },
  'gemini-thinking': {
    provider: 'google',
    model: 'gemini-2.0-flash-thinking-exp',
    maxTokens: 16000,
    temperature: 0.3,
    name: 'Gemini 2.0 Flash Thinking'
  }
};

const CURRENT_MODEL = MODEL_CONFIGS[MODEL_CHOICE];

if (!CURRENT_MODEL) {
  throw new Error(`Invalid MODEL_CHOICE: ${MODEL_CHOICE}. Must be one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
}

module.exports = {
  MODEL_CHOICE,
  CURRENT_MODEL,
  MODEL_CONFIGS
};