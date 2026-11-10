import { err, ok, type Result } from '../result';

import { MAX_EXPLANATION_CHARACTERS } from './limits';
import type { AiFailure, ContextExplanation } from './types';

/**
 * Provider output, treated as hostile input.
 *
 * A reply is not content until it has been parsed. It may be prose where
 * JSON was asked for, a thousand unexpected keys, a claim about which model
 * answered, control characters, or two megabytes of text. Every one of
 * those becomes a typed failure or a bounded value here, before anything
 * reaches the store or the screen.
 *
 * What this function deliberately does **not** do:
 *
 * - it does not repair malformed JSON, strip code fences or hunt for an
 *   object inside prose — a reply that ignored the contract is
 *   `unusable-response`, and silently accepting it would also accept the
 *   output of a successful prompt injection;
 * - it does not read `provider`, `model`, `usage` or any other field; local
 *   configuration is the only authority on who answered (threat T10);
 * - it does not keep a sense index that was never offered.
 */

export interface ParseExplanationOptions {
  /** How many senses were sent; an index outside the list is discarded. */
  readonly senseCount: number;
  /** True when the provider reported that it stopped early. */
  readonly stoppedEarly?: boolean;
}

/**
 * Control characters, removed rather than escaped.
 *
 * Tabs and newlines survive as whitespace because a model may legitimately
 * use them; everything else in C0/C1 is removed, so a reply cannot carry
 * terminal escapes or bidirectional-override tricks into a log or a label.
 */
// Matching control characters is the purpose of this expression, so the
// rule that warns about them accidentally appearing is disabled here only.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const BIDIRECTIONAL = /[\u202A-\u202E\u2066-\u2069]/gu;

const clean = (value: string): string =>
  value
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_CHARACTERS, '')
    .replace(BIDIRECTIONAL, '')
    .replace(/\t/gu, ' ')
    .trim();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const malformed: Result<ContextExplanation, AiFailure> = err({
  kind: 'unusable-response',
  reason: 'malformed',
});

/**
 * Validates one provider reply.
 *
 * `content` is the model's message body as the adapter extracted it: the
 * envelope around it is the adapter's business, the contract inside it is
 * this function's.
 */
export const parseExplanationContent = (
  content: unknown,
  { senseCount, stoppedEarly = false }: ParseExplanationOptions,
): Result<ContextExplanation, AiFailure> => {
  if (typeof content !== 'string') {
    return malformed;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(content.trim());
  } catch {
    return malformed;
  }

  if (!isObject(payload) || typeof payload['explanation'] !== 'string') {
    return malformed;
  }

  const cleaned = clean(payload['explanation']);

  if (cleaned.length === 0) {
    return err({ kind: 'unusable-response', reason: 'empty' });
  }

  const overLong = cleaned.length > MAX_EXPLANATION_CHARACTERS;
  const text = overLong ? cleaned.slice(0, MAX_EXPLANATION_CHARACTERS).trimEnd() : cleaned;

  // An index the model invented, or one pointing into a list that was never
  // sent, is dropped. A wrong pointer is not worth failing the answer for,
  // but it must never be shown as a sense the reader can check.
  const raw = payload['sense_index'];
  const senseIndex =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < senseCount ? raw : null;

  return ok({ text, senseIndex, truncated: overLong || stoppedEarly });
};
