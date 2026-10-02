export const DEFAULT_MODEL = 'snowflake-llama-3.3-70b';

export function inferenceConfig(env = process.env) {
  const selection = env.INFERENCE_PROVIDER || 'auto';
  if (!['auto', 'mock', 'snowflake'].includes(selection)) throw new Error('Unknown inference provider');
  // Partial credentials must produce a configuration error, never a mock estimate.
  const provider = selection === 'auto'
    ? (env.SNOWFLAKE_ACCOUNT_URL || env.SNOWFLAKE_TOKEN ? 'snowflake' : 'mock')
    : selection;
  return {provider, model: env.SNOWFLAKE_MODEL || DEFAULT_MODEL};
}
