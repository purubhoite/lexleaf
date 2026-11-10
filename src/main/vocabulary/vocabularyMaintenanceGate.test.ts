import { describe, expect, it } from 'vitest';
import { createVocabularyMaintenanceGate } from './vocabularyMaintenanceGate';

describe('vocabulary maintenance gate', () => {
  it('refuses restoration while active operations exist and blocks new admission during restore', () => {
    const gate = createVocabularyMaintenanceGate();
    const release = gate.enter();
    expect(release).not.toBeNull();
    expect(gate.beginRestore()).toBe(false);
    release?.();
    expect(gate.beginRestore()).toBe(true);
    expect(gate.enter()).toBeNull();
    gate.finishRestore(false);
    expect(gate.enter()).toBeNull();
    gate.finishRestore(true);
    expect(gate.enter()).not.toBeNull();
  });
});
