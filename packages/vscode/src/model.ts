/**
 * Bridges VS Code's Language Model API into AskSQL's engine: the user's chosen
 * chat model (Copilot or any registered provider) is wrapped as an AskSQL
 * CustomModel, so no separate API key is needed.
 */

import * as vscode from 'vscode';
import { AskSqlError, type CustomModel } from '@asksql/core';

/**
 * Wrap a VS Code chat model as an AskSQL CustomModel.
 * AskSQL cancels with an AbortSignal; VS Code cancels with a CancellationToken,
 * so we bridge the two and always dispose the source.
 */
export function lmCustomModel(lm: vscode.LanguageModelChat): CustomModel {
  return async ({ system, prompt, signal }) => {
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    if (signal) {
      if (signal.aborted) cts.cancel();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // The engine builds one system + one user prompt; VS Code models take a
      // message list, so the system prompt leads the turn.
      const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n${prompt}`)];
      const res = await lm.sendRequest(messages, {}, cts.token);
      // Collect rather than return the stream: the stream is bound to the token
      // source, which must outlive it, and the engine only needs the text.
      let out = '';
      for await (const chunk of res.text) out += chunk;
      return out;
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        // Map VS Code's model errors onto AskSQL's taxonomy so the UI and the
        // engine's retry logic behave exactly as they do for other providers.
        const code =
          err.code === vscode.LanguageModelError.NoPermissions().code
            ? 'LLM_AUTH'
            : err.code === vscode.LanguageModelError.Blocked().code
              ? 'LLM_BAD_OUTPUT'
              : 'LLM_UNAVAILABLE';
        throw new AskSqlError(code as 'LLM_AUTH' | 'LLM_BAD_OUTPUT' | 'LLM_UNAVAILABLE', {
          detail: `${err.code}: ${err.message}`,
          userMessage:
            code === 'LLM_AUTH'
              ? 'The chat model declined the request. Check that this workspace is allowed to use it.'
              : 'The chat model is unavailable right now. Try again, or pick a different model in the chat dropdown.',
          cause: err,
        });
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  };
}
