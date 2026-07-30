/**
 * A real connectivity check, not just client construction: `resolveModel`
 * alone never sends a request, so a wrong key/model/endpoint would report
 * success either way. This actually calls the model.
 */
import { generateText, APICallError } from 'ai';
import { resolveModel, type ProviderConfig } from '@asksql/core';

export async function testProviderConnectivity(config: ProviderConfig): Promise<void> {
  const model = await resolveModel(config);
  // The CustomModel function half of ModelLike comes only from the window.__asksqlModel test hook (sidepanel/main.tsx), which never reaches this function.
  if (typeof model === 'function') {
    throw new Error('AskSQL internal error: resolveModel returned a custom model instead of a real provider.');
  }
  try {
    await generateText({ model, prompt: 'Reply with the single word OK.', maxOutputTokens: 5 });
  } catch (err) {
    if (!(err instanceof APICallError)) throw err;
    if (config.provider === 'ollama' && err.statusCode === 403) {
      throw new Error(
        "Ollama refused this request (403 Forbidden) - it doesn't allow the extension's origin by default. " +
          'Restart Ollama with OLLAMA_ORIGINS=chrome-extension://* (or your extension\'s exact id) set, then try again.',
      );
    }
    if (err.statusCode === 401 || err.statusCode === 403) {
      throw new Error(`The API key was not accepted (${err.statusCode}).`);
    }
    throw err;
  }
}
