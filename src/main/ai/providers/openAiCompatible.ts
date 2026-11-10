import { MAX_RESPONSE_BYTES } from '@core/ai/limits';
import { parseExplanationContent } from '@core/ai/parseResponse';
import { assemblePrompt } from '@core/ai/prompt';
import type {
  AiFailure,
  ContextExplainer,
  ContextExplanation,
  ContextExplanationRequest,
  ProviderDescription,
} from '@core/ai/types';
import { err, type Result } from '@core/result';

import { failureForAbort } from '../abort';
import { describeConfiguration, parseEndpoint, type AiConfiguration } from '../configuration';

/**
 * One adapter, for the one wire format M5 speaks.
 *
 * Everything vendor-shaped in the application lives in this file: the path,
 * the headers, the request body, the envelope around the model's message.
 * A different provider later is a sibling file, not a change to the port
 * (ADR-027).
 *
 * What the adapter guarantees to everything above it:
 *
 * - **It never follows a redirect.** `redirect: 'error'` — an endpoint that
 *   bounces the excerpt somewhere else fails instead.
 * - **It never trusts the size of what it is given.** The body is counted
 *   while it is read and the read is abandoned at `MAX_RESPONSE_BYTES`, so
 *   an endless response costs a bounded amount of memory.
 * - **It never surfaces provider detail.** HTTP status, headers, body text
 *   and URLs become one of the closed failure kinds. Nothing else leaves.
 * - **It never echoes the credential**, not in a value, not in a
 *   diagnostic, not in an error.
 * - **It never opens a socket in a test.** The `fetch` it uses is injected;
 *   production passes Electron's `net.fetch` (reviewer decision D3).
 */

/** The shape of the function the adapter is given. Matches `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  readonly configuration: AiConfiguration;
  readonly fetchImpl: FetchLike;
  /** Per-request fence delimiter; injected so the prompt stays testable. */
  readonly nonce: () => string;
  /** Main-process diagnostics: never the prompt, the excerpt or the answer. */
  readonly onDiagnostic?: (message: string) => void;
}

/** Bounded so a provider cannot be asked for an unbounded amount of text. */
const MAX_COMPLETION_TOKENS = 800;

const COMPLETIONS_PATH = '/chat/completions';

const failed = (failure: AiFailure): Result<ContextExplanation, AiFailure> => err(failure);

const statusFailure = (status: number): AiFailure => {
  if (status === 401 || status === 403) {
    return { kind: 'rejected', reason: 'auth' };
  }

  if (status === 429) {
    return { kind: 'rejected', reason: 'rate-limited' };
  }

  if (status === 402) {
    return { kind: 'rejected', reason: 'quota' };
  }

  return { kind: 'provider-error' };
};

/**
 * Reads a body, counting bytes as they arrive.
 *
 * The cap is enforced **while** reading rather than afterwards: by the time
 * `text()` has resolved on a hostile response, the memory has already been
 * spent.
 */
type BoundedBody =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'oversized' };

const readBounded = async (response: Response): Promise<BoundedBody> => {
  const body = response.body as ReadableStream<Uint8Array> | null;

  if (body === null) {
    return { kind: 'text', text: '' };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      return { kind: 'text', text: text + decoder.decode() };
    }

    bytes += chunk.value.byteLength;

    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();

      return { kind: 'oversized' };
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Pulls the model's message out of the envelope. Everything else is ignored. */
const messageOf = (body: unknown): { content: unknown; finishReason: unknown } | null => {
  if (!isObject(body) || !Array.isArray(body['choices'])) {
    return null;
  }

  const choice: unknown = body['choices'][0];

  if (!isObject(choice) || !isObject(choice['message'])) {
    return null;
  }

  return { content: choice['message']['content'], finishReason: choice['finish_reason'] };
};

export const createOpenAiCompatibleExplainer = ({
  configuration,
  fetchImpl,
  nonce,
  onDiagnostic = (): void => {},
}: OpenAiCompatibleOptions): ContextExplainer => {
  const describe = (): ProviderDescription => describeConfiguration(configuration);

  const explain = async (
    request: ContextExplanationRequest,
    signal: AbortSignal,
  ): Promise<Result<ContextExplanation, AiFailure>> => {
    // Checked again here, not only at load time: the adapter must be safe
    // to construct from any configuration object, including one a future
    // caller assembled by hand.
    const endpoint = parseEndpoint(configuration.endpoint);

    if (endpoint === null) {
      onDiagnostic('an explanation was not requested: the configured endpoint is not permitted');

      return failed({ kind: 'not-configured' });
    }

    const prompt = assemblePrompt(request, nonce());
    const url = `${configuration.endpoint.replace(/\/$/u, '')}${COMPLETIONS_PATH}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };

    if (configuration.apiKey !== null) {
      headers['authorization'] = `Bearer ${configuration.apiKey}`;
    }

    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: configuration.modelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0,
          max_tokens: MAX_COMPLETION_TOKENS,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) {
        return failed(failureForAbort(signal));
      }

      const message = error instanceof Error ? error.message : String(error);

      // A redirect refusal is the endpoint behaving unexpectedly, not the
      // machine being offline; the distinction matters in the log only.
      if (/redirect/iu.test(message)) {
        onDiagnostic('an explanation request was refused: the endpoint attempted a redirect');

        return failed({ kind: 'provider-error' });
      }

      return failed({ kind: 'offline' });
    }

    if (!response.ok) {
      // The body of an error response may contain anything, including the
      // key echoed back. It is never read.
      void response.body?.cancel();
      onDiagnostic(`an explanation request failed with status ${String(response.status)}`);

      return failed(statusFailure(response.status));
    }

    let raw: BoundedBody;

    try {
      raw = await readBounded(response);
    } catch {
      return signal.aborted
        ? failed(failureForAbort(signal))
        : failed({ kind: 'unusable-response', reason: 'malformed' });
    }

    if (raw.kind === 'oversized') {
      onDiagnostic('an explanation reply exceeded the response byte cap and was discarded');

      return failed({ kind: 'unusable-response', reason: 'oversized' });
    }

    let envelope: unknown;

    try {
      envelope = JSON.parse(raw.text);
    } catch {
      return failed({ kind: 'unusable-response', reason: 'malformed' });
    }

    const message = messageOf(envelope);

    if (message === null) {
      return failed({ kind: 'unusable-response', reason: 'malformed' });
    }

    if (message.finishReason === 'content_filter') {
      return failed({ kind: 'rejected', reason: 'refused' });
    }

    return parseExplanationContent(message.content, {
      senseCount: request.senses.length,
      stoppedEarly: message.finishReason === 'length',
    });
  };

  return { describe, explain };
};
