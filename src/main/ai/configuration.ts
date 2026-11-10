import type { ProviderDescription } from '@core/ai/types';

import { endpointFingerprint } from './digest';

/**
 * Where the provider configuration comes from, and what it is allowed to be.
 *
 * Milestone 5 ships **no settings UI and no in-app credential entry**
 * (reviewer decision D6). A provider is configured out of band, in the main
 * process only, by either:
 *
 * - three environment variables, or
 * - a JSON file in the per-user data directory with mode `0600`.
 *
 * Everything this module produces is main-process state. The endpoint, the
 * key and the file path never cross IPC, never appear in `describe()` and
 * never reach a log line. What the renderer can learn is a destination
 * label, a model name and whether the destination is this machine.
 *
 * Two validations are not negotiable, because they are the difference
 * between "the user chose a provider" and "something chose one for them":
 *
 * - the scheme must be `https:`, or `http:` to a loopback host. A plaintext
 *   request to a remote host would send the excerpt in clear;
 * - a malformed or unsafe configuration yields `null`, which means the
 *   feature is simply absent — no control, no error, no prompt to set
 *   anything up.
 */

/** The adapter family. Readable in diagnostics; never a commitment. */
/** Initial public release policy: AI is retained in the codebase but unavailable. */
export const AI_FEATURE_ENABLED = false;

export const AI_ADAPTER_ID = 'openai-compatible';

export const ENDPOINT_VARIABLE = 'INTELLIGENT_PDF_READER_AI_ENDPOINT';
export const MODEL_VARIABLE = 'INTELLIGENT_PDF_READER_AI_MODEL';
export const KEY_VARIABLE = 'INTELLIGENT_PDF_READER_AI_KEY';

/** Name of the optional configuration file inside the user data directory. */
export const CONFIGURATION_FILE = 'ai-provider.json';

/** The longest model name that will be accepted, so a row cannot grow without bound. */
const MAXIMUM_MODEL_LENGTH = 128;

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1'];

export interface AiConfiguration {
  readonly adapterId: string;
  /** Base URL of the provider. Main-process only. */
  readonly endpoint: string;
  readonly modelId: string;
  /** Main-process only. Never logged, never sent, never stored. */
  readonly apiKey: string | null;
  /** `adapterId:fingerprint`, part of explanation identity. */
  readonly providerId: string;
  /** False only when the destination is this machine. */
  readonly remote: boolean;
  /** What the popup may show before anything is sent. */
  readonly destinationLabel: string;
}

export interface ConfigurationFileContents {
  readonly contents: string;
  /** The file's permission bits, as from `stat`. */
  readonly mode: number;
}

export interface AiConfigurationSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads the optional configuration file. Returns `null` when absent. */
  readonly readConfigurationFile: () => ConfigurationFileContents | null;
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * The canonical form the fingerprint is taken over.
 *
 * `https://host` and `https://host:443/` fingerprint identically, because
 * they are the same destination; `https://host/v1` and `https://host/v2`
 * do not, because they are not.
 */
export const canonicalEndpoint = (url: URL): string => {
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const port = url.port === '' ? (scheme === 'https' ? '443' : '80') : url.port;
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;

  return `${scheme}://${url.hostname.toLowerCase()}:${port}${path}`;
};

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());

/** Parses and judges an endpoint. `null` means "not usable", never "try anyway". */
export const parseEndpoint = (value: string): URL | null => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    // Credentials or parameters in the URL would end up in the fingerprint
    // and in any future diagnostic. They belong in the key field or not at
    // all.
    return null;
  }

  if (url.protocol === 'https:') {
    return url;
  }

  return url.protocol === 'http:' && isLoopback(url) ? url : null;
};

/**
 * The destination, in words a reader can act on.
 *
 * Always the configured host — including a loopback one, where
 * `localhost:11434` says far more than "this device" and does not read as a
 * tautology next to the control's "runs on this computer". It is a label,
 * never the URL: no scheme, no path, no query, no credential.
 */
const describeHost = (url: URL): string => url.host;

const build = (endpoint: URL, modelId: string, apiKey: string | null): AiConfiguration | null => {
  const trimmedModel = modelId.trim();

  if (trimmedModel.length === 0 || trimmedModel.length > MAXIMUM_MODEL_LENGTH) {
    return null;
  }

  const remote = !isLoopback(endpoint);

  return {
    adapterId: AI_ADAPTER_ID,
    endpoint: endpoint.toString(),
    modelId: trimmedModel,
    apiKey: apiKey === null || apiKey.length === 0 ? null : apiKey,
    providerId: `${AI_ADAPTER_ID}:${endpointFingerprint(canonicalEndpoint(endpoint))}`,
    remote,
    destinationLabel: describeHost(endpoint),
  };
};

const fromEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  onDiagnostic: (message: string) => void,
): AiConfiguration | null => {
  const rawEndpoint = env[ENDPOINT_VARIABLE];
  const rawModel = env[MODEL_VARIABLE];

  if (rawEndpoint === undefined || rawModel === undefined) {
    return null;
  }

  const endpoint = parseEndpoint(rawEndpoint.trim());

  if (endpoint === null) {
    onDiagnostic(
      `${ENDPOINT_VARIABLE} was ignored: an endpoint must be https, or http to a loopback host, with no credentials or query`,
    );

    return null;
  }

  const configuration = build(endpoint, rawModel, env[KEY_VARIABLE] ?? null);

  if (configuration === null) {
    onDiagnostic(`${MODEL_VARIABLE} was ignored: a model name is required and is bounded`);
  }

  return configuration;
};

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const fromFile = (
  file: ConfigurationFileContents,
  onDiagnostic: (message: string) => void,
): AiConfiguration | null => {
  // Group and world bits mean another account on this machine can read the
  // key. That is a refusal, not a warning to be clicked through.
  if ((file.mode & 0o077) !== 0) {
    onDiagnostic(
      `${CONFIGURATION_FILE} was ignored: it must not be readable by other users (expected mode 0600)`,
    );

    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(file.contents);
  } catch {
    onDiagnostic(`${CONFIGURATION_FILE} was ignored: it is not valid JSON`);

    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    onDiagnostic(`${CONFIGURATION_FILE} was ignored: it is not an object`);

    return null;
  }

  const record = parsed as Record<string, unknown>;
  const rawEndpoint = readString(record['endpoint']);
  const rawModel = readString(record['model']);

  if (rawEndpoint === null || rawModel === null) {
    onDiagnostic(`${CONFIGURATION_FILE} was ignored: it needs an endpoint and a model`);

    return null;
  }

  const endpoint = parseEndpoint(rawEndpoint.trim());

  if (endpoint === null) {
    onDiagnostic(
      `${CONFIGURATION_FILE} was ignored: an endpoint must be https, or http to a loopback host, with no credentials or query`,
    );

    return null;
  }

  const configuration = build(endpoint, rawModel, readString(record['apiKey']));

  if (configuration === null) {
    onDiagnostic(`${CONFIGURATION_FILE} was ignored: the model name is empty or too long`);
  }

  return configuration;
};

/**
 * Resolves the configured provider, or `null` when there is none.
 *
 * The environment wins over the file, so a developer can point one run at a
 * loopback server without editing anything. Nothing here reads the network,
 * and nothing here throws: a configuration problem disables the feature and
 * says so in the main-process log, where the detail is safe.
 */
export const loadAiConfiguration = ({
  env,
  readConfigurationFile,
  onDiagnostic = (): void => {},
}: AiConfigurationSources): AiConfiguration | null => {
  const fromEnv = fromEnvironment(env, onDiagnostic);

  if (fromEnv !== null) {
    return fromEnv;
  }

  const file = readConfigurationFile();

  return file === null ? null : fromFile(file, onDiagnostic);
};

/**
 * What may be disclosed.
 *
 * Note what is absent: the endpoint, the path, the fingerprint input and
 * the key. A reader is told where their excerpt would go in words they can
 * act on, and nothing more.
 */
export const describeConfiguration = (configuration: AiConfiguration): ProviderDescription => ({
  provider: configuration.destinationLabel,
  model: configuration.modelId,
  remote: configuration.remote,
});
