import { describe, expect, it } from 'vitest';

import {
  AI_ADAPTER_ID,
  AI_FEATURE_ENABLED,
  CONFIGURATION_FILE,
  ENDPOINT_VARIABLE,
  KEY_VARIABLE,
  MODEL_VARIABLE,
  canonicalEndpoint,
  describeConfiguration,
  loadAiConfiguration,
  parseEndpoint,
  type AiConfiguration,
  type ConfigurationFileContents,
} from './configuration';

const load = (
  env: Record<string, string | undefined>,
  file: ConfigurationFileContents | null = null,
  onDiagnostic?: (message: string) => void,
): AiConfiguration | null =>
  loadAiConfiguration({
    env,
    readConfigurationFile: () => file,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });

const REMOTE = {
  [ENDPOINT_VARIABLE]: 'https://api.example.com/v1',
  [MODEL_VARIABLE]: 'small-model',
  [KEY_VARIABLE]: 'sk-secret-value',
};

describe('initial public release policy', () => {
  it('keeps AI disabled', () => {
    expect(AI_FEATURE_ENABLED).toBe(false);
  });
});

describe('with nothing configured', () => {
  it('reports no provider', () => {
    expect(load({})).toBeNull();
  });

  it('reads nothing but the sources it was given', () => {
    let reads = 0;

    expect(
      loadAiConfiguration({
        env: {},
        readConfigurationFile: () => {
          reads += 1;

          return null;
        },
      }),
    ).toBeNull();
    expect(reads).toBe(1);
  });
});

describe('an endpoint', () => {
  it.each([
    ['plain http to a remote host', 'http://api.example.com/v1'],
    ['a credential in the url', 'https://user:pass@api.example.com/v1'],
    ['a query string', 'https://api.example.com/v1?key=secret'],
    ['a fragment', 'https://api.example.com/v1#part'],
    ['nonsense', 'not a url'],
    ['another scheme', 'file:///etc/passwd'],
    ['a websocket', 'ws://127.0.0.1:1234'],
  ])('is refused when it is %s', (_label, value) => {
    expect(parseEndpoint(value)).toBeNull();
  });

  it.each([
    ['https', 'https://api.example.com/v1'],
    ['loopback by address', 'http://127.0.0.1:11434/v1'],
    ['loopback by name', 'http://localhost:11434/v1'],
    ['loopback over IPv6', 'http://[::1]:11434/v1'],
  ])('is accepted when it is %s', (_label, value) => {
    expect(parseEndpoint(value)).not.toBeNull();
  });
});

describe('the canonical endpoint', () => {
  it('treats a default port and an explicit one as the same destination', () => {
    expect(canonicalEndpoint(new URL('https://api.example.com/v1'))).toBe(
      canonicalEndpoint(new URL('https://api.example.com:443/v1')),
    );
  });

  it('ignores one trailing slash and the case of the host', () => {
    expect(canonicalEndpoint(new URL('https://API.Example.com/v1/'))).toBe(
      canonicalEndpoint(new URL('https://api.example.com/v1')),
    );
  });

  it('keeps different base paths apart', () => {
    expect(canonicalEndpoint(new URL('https://api.example.com/v1'))).not.toBe(
      canonicalEndpoint(new URL('https://api.example.com/v2')),
    );
  });
});

describe('the provider id', () => {
  it('names the adapter family and a fingerprint', () => {
    const configuration = load(REMOTE);

    expect(configuration?.providerId).toMatch(new RegExp(`^${AI_ADAPTER_ID}:[0-9a-f]{16}$`, 'u'));
  });

  it('is the same for equivalent spellings of one endpoint', () => {
    const first = load({ ...REMOTE, [ENDPOINT_VARIABLE]: 'https://api.example.com/v1' });
    const second = load({ ...REMOTE, [ENDPOINT_VARIABLE]: 'https://api.example.com:443/v1/' });

    expect(first?.providerId).toBe(second?.providerId);
  });

  it('differs for two configured endpoints', () => {
    const hosted = load(REMOTE);
    const local = load({ ...REMOTE, [ENDPOINT_VARIABLE]: 'http://127.0.0.1:11434/v1' });

    expect(hosted?.providerId).not.toBe(local?.providerId);
  });

  it('does not change when only the credential changes', () => {
    const first = load({ ...REMOTE, [KEY_VARIABLE]: 'sk-one' });
    const second = load({ ...REMOTE, [KEY_VARIABLE]: 'sk-two' });

    expect(first?.providerId).toBe(second?.providerId);
  });

  it('contains neither the endpoint nor the key', () => {
    const configuration = load(REMOTE);

    expect(configuration?.providerId).not.toContain('api.example.com');
    expect(configuration?.providerId).not.toContain('sk-secret-value');
  });
});

describe('what may be disclosed', () => {
  it('names the destination host and the model for a remote provider', () => {
    const configuration = load(REMOTE);

    expect(configuration === null ? null : describeConfiguration(configuration)).toEqual({
      provider: 'api.example.com',
      model: 'small-model',
      remote: true,
    });
  });

  it('names the loopback host itself, not a vague label, for a local provider', () => {
    const configuration = load({
      ...REMOTE,
      [ENDPOINT_VARIABLE]: 'http://127.0.0.1:11434/v1',
      [KEY_VARIABLE]: undefined,
    });

    expect(configuration === null ? null : describeConfiguration(configuration)).toEqual({
      provider: '127.0.0.1:11434',
      model: 'small-model',
      remote: false,
    });
  });

  it('never includes the credential or the endpoint path', () => {
    const configuration = load(REMOTE);
    const described = JSON.stringify(
      configuration === null ? {} : describeConfiguration(configuration),
    );

    expect(described).not.toContain('sk-secret-value');
    expect(described).not.toContain('/v1');
    expect(described).not.toContain('https://');
  });
});

describe('the configuration file', () => {
  const file = (contents: string, mode = 0o600): ConfigurationFileContents => ({ contents, mode });

  it('is used when the environment says nothing', () => {
    const configuration = load(
      {},
      file(JSON.stringify({ endpoint: 'https://api.example.com/v1', model: 'm', apiKey: 'k' })),
    );

    expect(configuration?.modelId).toBe('m');
    expect(configuration?.apiKey).toBe('k');
  });

  it('is ignored when other users can read it', () => {
    const messages: string[] = [];
    const configuration = load(
      {},
      file(JSON.stringify({ endpoint: 'https://api.example.com/v1', model: 'm' }), 0o644),
      (message) => messages.push(message),
    );

    expect(configuration).toBeNull();
    expect(messages.join(' ')).toContain('0600');
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[]'],
    ['missing a model', JSON.stringify({ endpoint: 'https://api.example.com/v1' })],
    ['missing an endpoint', JSON.stringify({ model: 'm' })],
    [
      'pointing at a remote plaintext endpoint',
      JSON.stringify({ endpoint: 'http://a.example', model: 'm' }),
    ],
  ])('is ignored when it is %s', (_label, contents) => {
    const messages: string[] = [];

    expect(load({}, file(contents), (message) => messages.push(message))).toBeNull();
    expect(messages.join(' ')).toContain(CONFIGURATION_FILE);
  });

  it('never has its contents repeated in a diagnostic', () => {
    const messages: string[] = [];

    load(
      {},
      file(
        JSON.stringify({
          endpoint: 'https://api.example.com/v1',
          model: '',
          apiKey: 'sk-secret-value',
        }),
      ),
      (message) => messages.push(message),
    );

    expect(messages.join(' ')).not.toContain('sk-secret-value');
  });
});

describe('the environment', () => {
  it('wins over the file', () => {
    const configuration = load(REMOTE, {
      contents: JSON.stringify({ endpoint: 'http://127.0.0.1:1/v1', model: 'file' }),
      mode: 0o600,
    });

    expect(configuration?.modelId).toBe('small-model');
  });

  it('needs both an endpoint and a model', () => {
    expect(load({ [ENDPOINT_VARIABLE]: 'https://api.example.com/v1' })).toBeNull();
    expect(load({ [MODEL_VARIABLE]: 'small-model' })).toBeNull();
  });

  it('reports a refused endpoint without repeating the key', () => {
    const messages: string[] = [];

    expect(
      load({ ...REMOTE, [ENDPOINT_VARIABLE]: 'http://api.example.com/v1' }, null, (message) =>
        messages.push(message),
      ),
    ).toBeNull();
    expect(messages.join(' ')).toContain(ENDPOINT_VARIABLE);
    expect(messages.join(' ')).not.toContain('sk-secret-value');
  });

  it('treats an empty key as no key', () => {
    expect(load({ ...REMOTE, [KEY_VARIABLE]: '' })?.apiKey).toBeNull();
  });
});
