/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chooseVoice, speechChunks, useReadAloud } from './useReadAloud';

const voice = (lang: string, localService: boolean, isDefault = false): SpeechSynthesisVoice =>
  ({ lang, localService, default: isDefault, name: lang, voiceURI: lang }) as SpeechSynthesisVoice;

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

const install = (voices: SpeechSynthesisVoice[] = [voice('en-GB', true)]) => {
  const spoken: FakeUtterance[] = [];
  const synthesis = {
    getVoices: () => voices,
    cancel: vi.fn(),
    speak: vi.fn((utterance: FakeUtterance) => {
      spoken.push(utterance);
    }),
  };

  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

  return { spoken, synthesis };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('splitting text to be spoken', () => {
  it('says nothing for nothing', () => {
    expect(speechChunks('  \n ')).toStrictEqual([]);
  });

  it('keeps short text whole and tidies its spacing', () => {
    expect(speechChunks('One  two.\nThree.')).toStrictEqual(['One two. Three.']);
  });

  it('breaks long text at sentence ends', () => {
    expect(speechChunks('First sentence here. Second sentence here. Third.', 25)).toStrictEqual([
      'First sentence here.',
      'Second sentence here.',
      'Third.',
    ]);
  });

  it('breaks one over-long sentence at spaces, losing no word', () => {
    const chunks = speechChunks('alpha beta gamma delta epsilon zeta', 12);

    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.join(' ')).toBe('alpha beta gamma delta epsilon zeta');
  });
});

describe('choosing a voice', () => {
  it('never chooses a voice that is not on this computer', () => {
    expect(chooseVoice([voice('en-US', false, true)], 'en-US')).toBeNull();
  });

  it("prefers the system's language, then English, then anything local", () => {
    const french = voice('fr-FR', true);
    const english = voice('en-GB', true);

    expect(chooseVoice([english, french], 'fr-CA')).toBe(french);
    expect(chooseVoice([french, english], 'de-DE')).toBe(english);
    expect(chooseVoice([french], 'de-DE')).toBe(french);
  });
});

describe('reading aloud', () => {
  it('speaks piece by piece with a local voice and ends idle', () => {
    const { spoken } = install();
    const { result } = renderHook(() => useReadAloud());

    act(() => {
      result.current.speak(`${'word '.repeat(60)}. Second sentence.`);
    });

    expect(result.current.status).toBe('speaking');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.voice?.lang).toBe('en-GB');

    // Each piece is only begun when the one before has finished.
    for (let index = 0; index < 10 && result.current.status === 'speaking'; index += 1) {
      act(() => {
        spoken[spoken.length - 1]?.onend?.();
      });
    }

    expect(spoken.length).toBeGreaterThan(1);
    expect(result.current.status).toBe('idle');
  });

  it('stops at once and does not carry on with the next piece', () => {
    const { spoken, synthesis } = install();
    const { result } = renderHook(() => useReadAloud());

    act(() => {
      result.current.speak(`${'word '.repeat(60)}. Second sentence.`);
    });
    act(() => {
      result.current.stop();
    });

    expect(synthesis.cancel).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');

    act(() => {
      spoken[0]?.onend?.();
    });

    expect(spoken).toHaveLength(1);
  });

  it('says so when the computer has no speech at all', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const { result } = renderHook(() => useReadAloud());

    let started = true;

    act(() => {
      started = result.current.speak('hello');
    });

    expect(started).toBe(false);
    expect(result.current.status).toBe('unavailable');
  });

  it('reports a voice that fails, but not a reading that was stopped', () => {
    const { spoken } = install();
    const { result } = renderHook(() => useReadAloud());

    act(() => {
      result.current.speak('hello');
    });
    act(() => {
      spoken[0]?.onerror?.({ error: 'synthesis-unavailable' });
    });

    expect(result.current.status).toBe('unavailable');

    act(() => {
      result.current.speak('hello');
    });
    act(() => {
      spoken[1]?.onerror?.({ error: 'interrupted' });
    });

    expect(result.current.status).toBe('idle');
  });

  it('falls silent when the reader goes away', () => {
    const { synthesis } = install();
    const { result, unmount } = renderHook(() => useReadAloud());

    act(() => {
      result.current.speak('hello');
    });
    synthesis.cancel.mockClear();
    unmount();

    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });
});
