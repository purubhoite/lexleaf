/**
 * How much the interface is allowed to move: the reduced-motion value, and
 * nothing else.
 *
 * ADR-032 gives the reduced-motion contract two inputs that mean the same
 * thing — the operating system's own setting, which CSS answers directly
 * through `prefers-reduced-motion`, and an explicit in-application choice,
 * which has to reach the cascade as an attribute on the document element.
 * This file is the second input's value, expressed the way ADR-031 says a
 * preference is expressed: one field, parsed in `core`, with a fallback to
 * its own default and no way to throw.
 *
 * It is deliberately only the value boundary, exactly as
 * `appearance.ts` was for 6.6. The reader-state schema that stores it, its
 * migration, the save channel and the settings control that writes it are
 * ADR-031's and arrived in 6.8; this file remains the only definition of
 * what the value may be.
 *
 * **The name.** 6.7 called this value a `MotionPreference`, while ADR-031
 * and ADR-032 both call the stored field `reduceMotion`. 6.8 had to store
 * it, so the two vocabularies could not both survive: the stored key is the
 * one the decisions name, and the code now says the same word. There is one
 * name, not an alias — `reduceMotion` is the field in `Preferences`, in the
 * reader-state document, in the IPC payload and in this module. The only
 * other vocabulary here is the *attribute* value below, which answers a
 * different question and is deliberately not called a preference.
 */

/**
 * `system` honours whatever the operating system says and nothing more;
 * `always` reduces motion regardless of what the system says.
 *
 * There is no `never`. A preference that *overrode* an operating system
 * asking for less motion would be an accessibility regression dressed up
 * as a choice, so the two states are "follow the system" and "more
 * strictly than the system", never less.
 */
export type ReduceMotion = 'system' | 'always';

/** Every valid value, in the order the settings surface offers them. */
export const REDUCE_MOTION_VALUES: readonly ReduceMotion[] = ['system', 'always'];

export const DEFAULT_REDUCE_MOTION: ReduceMotion = 'system';

/**
 * Reads a motion preference out of unvalidated input.
 *
 * Anything unrecognised — missing, misspelled, a number, an object, a value
 * from a newer build — becomes the default. A preference is never allowed
 * to be a reason the application does not start (ADR-031).
 */
export const parseReduceMotion = (value: unknown): ReduceMotion =>
  REDUCE_MOTION_VALUES.find((candidate) => candidate === value) ?? DEFAULT_REDUCE_MOTION;

/**
 * What the document element says, which is not the same vocabulary.
 *
 * The preference answers "when should motion be reduced"; the attribute
 * answers "should the cascade reduce it now". `system` leaves the question
 * to the `prefers-reduced-motion` media query in `global.css`; `reduced`
 * is the state in which that stylesheet disables motion unconditionally.
 */
export type MotionAttributeValue = 'system' | 'reduced';

export const resolveMotion = (preference: ReduceMotion): MotionAttributeValue =>
  preference === 'always' ? 'reduced' : 'system';
