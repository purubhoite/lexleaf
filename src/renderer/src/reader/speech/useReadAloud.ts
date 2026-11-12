import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reading text aloud with the computer's own voice.
 *
 * This uses the speech built into the operating system, through the
 * window's standard speech interface. Only voices that say they run on
 * this computer are used, so nothing that is read is sent anywhere — the
 * same promise the rest of Lexleaf makes.
 *
 * Long text is spoken a sentence or two at a time. Besides letting "Stop"
 * take effect promptly, this avoids a fault in which a very long single
 * utterance is cut off part-way.
 */

const CHUNK_LENGTH = 220;

export type ReadAloudStatus = 'idle' | 'speaking' | 'unavailable';

export interface ReadAloud {
  readonly status: ReadAloudStatus;
  /** Starts reading; returns `false` when this computer has no voice. */
  readonly speak: (text: string) => boolean;
  readonly stop: () => void;
}

export const NO_VOICE_MESSAGE =
  'This computer has no voice installed for reading aloud. On Windows, add one under Settings › Time & language › Speech. On Linux, install speech-dispatcher and espeak-ng.';

/** Splits text at sentence ends, then at spaces, into speakable pieces. */
export const speechChunks = (text: string, limit: number = CHUNK_LENGTH): string[] => {
  const clean = text.replace(/\s+/gu, ' ').trim();

  if (clean.length === 0) {
    return [];
  }

  const sentences = clean.match(/[^.!?…]+[.!?…]*["'”’)]*\s*/gu) ?? [clean];
  const chunks: string[] = [];
  let current = '';

  const push = (): void => {
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    current = '';
  };

  for (const sentence of sentences) {
    if (current.length + sentence.length <= limit) {
      current += sentence;
      continue;
    }

    push();

    if (sentence.length <= limit) {
      current = sentence;
      continue;
    }

    // One sentence longer than the limit: break it at spaces.
    for (const word of sentence.split(' ')) {
      if (current.length + word.length + 1 > limit) {
        push();
      }

      current += `${word} `;
    }
  }

  push();

  return chunks;
};

interface SpeechEngine {
  readonly synthesis: SpeechSynthesis;
  readonly Utterance: typeof SpeechSynthesisUtterance;
}

const engine = (): SpeechEngine | null => {
  const scope = globalThis as typeof globalThis & {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };

  return scope.speechSynthesis === undefined || scope.SpeechSynthesisUtterance === undefined
    ? null
    : { synthesis: scope.speechSynthesis, Utterance: scope.SpeechSynthesisUtterance };
};

/** A voice on this computer, in the system's language where there is one. */
export const chooseVoice = (
  voices: readonly SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | null => {
  const local = voices.filter((voice) => voice.localService);
  const prefix = language.slice(0, 2).toLowerCase();

  return (
    local.find((voice) => voice.default && voice.lang.toLowerCase().startsWith(prefix)) ??
    local.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ??
    local.find((voice) => voice.lang.toLowerCase().startsWith('en')) ??
    local.find((voice) => voice.default) ??
    local[0] ??
    null
  );
};

export const useReadAloud = (): ReadAloud => {
  const [status, setStatus] = useState<ReadAloudStatus>('idle');
  // Each reading has a number; a piece that finishes after "Stop" or after
  // a newer reading began must not carry on.
  const session = useRef(0);

  const stop = useCallback((): void => {
    session.current += 1;
    engine()?.synthesis.cancel();
    setStatus((current) => (current === 'speaking' ? 'idle' : current));
  }, []);

  const speak = useCallback((text: string): boolean => {
    const speech = engine();
    const chunks = speechChunks(text);

    if (speech === null) {
      setStatus('unavailable');

      return false;
    }

    if (chunks.length === 0) {
      return true;
    }

    const voice = chooseVoice(speech.synthesis.getVoices(), globalThis.navigator.language);

    // Voices can load a moment after the window does. An empty list is
    // only taken as "none installed" once speaking has actually failed.
    session.current += 1;

    const mine = session.current;

    speech.synthesis.cancel();
    setStatus('speaking');

    const next = (index: number): void => {
      if (session.current !== mine) {
        return;
      }

      const chunk = chunks[index];

      if (chunk === undefined) {
        setStatus('idle');

        return;
      }

      const utterance = new speech.Utterance(chunk);

      if (voice !== null) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }

      utterance.onend = (): void => {
        next(index + 1);
      };
      utterance.onerror = (event): void => {
        if (session.current !== mine) {
          return;
        }

        // "Stop" arrives here as an error too; it is not one.
        const reason = (event as { error?: string }).error;

        setStatus(reason === 'canceled' || reason === 'interrupted' ? 'idle' : 'unavailable');
      };

      speech.synthesis.speak(utterance);
    };

    next(0);

    return true;
  }, []);

  // Nothing keeps talking after the reader has gone.
  useEffect(
    () => (): void => {
      session.current += 1;
      engine()?.synthesis.cancel();
    },
    [],
  );

  return { status, speak, stop };
};
