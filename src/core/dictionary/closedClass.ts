import type { DictionaryPartOfSpeech } from './types';

/**
 * The curated closed-class layer.
 *
 * WordNet is a lexical database of *content* words. It has no entry for
 * "the", "of" or "and", and the entries it does have for "he", "at" and "a"
 * describe a Hebrew letter, a chemical element and a unit of length. Those
 * are the commonest words in any document, so leaving them unanswered — or
 * answered wrongly — would be a product defect however correct the data is
 * (ADR-019).
 *
 * Everything in this file is **application-authored content**. It is written
 * here, by this project, in functional terms: what the word does in a
 * sentence, and one short illustration. Nothing is copied from WordNet or
 * from any other dictionary, no entry claims an etymology, a pronunciation or
 * a sense count, and the layer is kept physically separate from third-party
 * material so that attribution stays truthful in both directions.
 *
 * Scope is deliberately narrow: determiners, pronouns, prepositions,
 * conjunctions, the auxiliary and modal verbs, the infinitive marker and the
 * negator. Content words are not described here even when they are frequent.
 */

export interface ClosedClassSense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly examples: readonly string[];
}

export interface ClosedClassEntry {
  /** The lowercase lookup key. */
  readonly key: string;
  readonly senses: readonly ClosedClassSense[];
}

type Row = readonly [DictionaryPartOfSpeech, string, string];

const rows: Readonly<Record<string, readonly Row[]>> = {
  /* ---- determiners ---- */
  the: [
    [
      'determiner',
      'Marks what follows as something the reader is already expected to be able to pick out.',
      'Hand me the report we discussed.',
    ],
  ],
  a: [
    [
      'determiner',
      'Introduces a single thing of some kind without saying which one.',
      'She drew a diagram on the board.',
    ],
  ],
  an: [
    [
      'determiner',
      'The form of "a" used before a word that starts with a vowel sound.',
      'He made an exception.',
    ],
  ],
  this: [
    [
      'determiner',
      'Points to the thing nearest to the speaker, or the one just mentioned.',
      'This chapter is the longest.',
    ],
    ['pronoun', 'Stands for the thing nearest to hand or just mentioned.', 'This is what I meant.'],
  ],
  that: [
    [
      'determiner',
      'Points to a thing further away than "this", or already identified.',
      'That page is missing.',
    ],
    [
      'conjunction',
      'Introduces a clause that reports or completes what came before it.',
      'He said that the meeting had moved.',
    ],
    [
      'pronoun',
      'Introduces a relative clause describing the noun before it.',
      'The file that arrived this morning.',
    ],
  ],
  these: [['determiner', 'The plural of "this".', 'These notes are mine.']],
  those: [['determiner', 'The plural of "that".', 'Those results came later.']],
  each: [
    [
      'determiner',
      'Refers to every member of a group taken one at a time.',
      'Each chapter opens with a summary.',
    ],
  ],
  every: [
    [
      'determiner',
      'Refers to all members of a group without exception.',
      'Every entry was checked.',
    ],
  ],
  some: [
    [
      'determiner',
      'Refers to an unstated quantity or to particular but unnamed members of a group.',
      'Some pages were blank.',
    ],
  ],
  any: [
    [
      'determiner',
      'Refers to one or more members of a group, with no restriction on which.',
      'Take any seat.',
    ],
  ],
  no: [
    ['determiner', 'States that there is not even one of the thing named.', 'There was no reply.'],
    ['particle', 'The word used on its own to refuse or deny.', 'No, that is not what happened.'],
  ],
  both: [['determiner', 'Refers to the two things already identified.', 'Both drafts were kept.']],
  either: [
    [
      'determiner',
      'Refers to one or the other of two possibilities.',
      'Either route gets you there.',
    ],
  ],
  neither: [
    ['determiner', 'Refers to not one and not the other of two.', 'Neither answer was right.'],
  ],
  which: [
    [
      'determiner',
      'Asks or specifies which members of a known set are meant.',
      'Which version are you reading?',
    ],
    [
      'pronoun',
      'Introduces a relative clause about a thing already named.',
      'The edition which he cites is out of print.',
    ],
  ],
  what: [
    [
      'determiner',
      'Asks for the identity or nature of something unknown.',
      'What evidence supports it?',
    ],
    ['pronoun', 'Stands for the thing being asked about or described.', 'Tell me what you found.'],
  ],
  whose: [
    [
      'determiner',
      'Asks or states which person or thing something belongs to.',
      'Whose copy is this?',
    ],
  ],

  /* ---- pronouns ---- */
  i: [['pronoun', 'The person speaking or writing, as the subject of a verb.', 'I disagree.']],
  me: [
    ['pronoun', 'The person speaking, as the object of a verb or preposition.', 'Send it to me.'],
  ],
  my: [['determiner', 'Belonging to the person speaking.', 'My notes are on the desk.']],
  mine: [['pronoun', 'The one belonging to the person speaking.', 'That copy is mine.']],
  you: [
    [
      'pronoun',
      'The person or people being addressed, as subject or object.',
      'You will need both volumes.',
    ],
  ],
  your: [
    ['determiner', 'Belonging to the person being addressed.', 'Your argument is clearer now.'],
  ],
  yours: [
    ['pronoun', 'The one belonging to the person being addressed.', 'The decision is yours.'],
  ],
  he: [
    [
      'pronoun',
      'A male person or animal already mentioned, as the subject of a verb.',
      'He left before the end.',
    ],
  ],
  him: [
    [
      'pronoun',
      'A male person already mentioned, as the object of a verb or preposition.',
      'I wrote to him.',
    ],
  ],
  his: [
    ['determiner', 'Belonging to a male person already mentioned.', 'His edition is annotated.'],
  ],
  she: [
    [
      'pronoun',
      'A female person or animal already mentioned, as the subject of a verb.',
      'She wrote the preface.',
    ],
  ],
  her: [
    [
      'pronoun',
      'A female person already mentioned, as the object of a verb or preposition.',
      'We asked her first.',
    ],
    ['determiner', 'Belonging to a female person already mentioned.', 'Her chapter is the third.'],
  ],
  hers: [
    ['pronoun', 'The one belonging to a female person already mentioned.', 'The idea was hers.'],
  ],
  it: [
    [
      'pronoun',
      'A thing already mentioned, or the formal subject of a verb about weather, time or distance.',
      'It is on the second shelf.',
    ],
  ],
  its: [['determiner', 'Belonging to the thing already mentioned.', 'The book lost its cover.']],
  we: [
    [
      'pronoun',
      'The speaker together with at least one other person, as the subject of a verb.',
      'We reached the same conclusion.',
    ],
  ],
  us: [
    [
      'pronoun',
      'The speaker and others, as the object of a verb or preposition.',
      'He showed us the manuscript.',
    ],
  ],
  our: [
    ['determiner', 'Belonging to the speaker and others.', 'Our findings are in the appendix.'],
  ],
  ours: [['pronoun', 'The one belonging to the speaker and others.', 'The error was ours.']],
  they: [
    [
      'pronoun',
      'People or things already mentioned, as the subject of a verb; also used of one person whose gender is unstated.',
      'They arrived separately.',
    ],
  ],
  them: [
    [
      'pronoun',
      'People or things already mentioned, as the object of a verb or preposition.',
      'I returned them unopened.',
    ],
  ],
  their: [
    [
      'determiner',
      'Belonging to people or things already mentioned; also used of one person whose gender is unstated.',
      'Their conclusions differ from ours.',
    ],
  ],
  theirs: [
    ['pronoun', 'The one belonging to people already mentioned.', 'The last word was theirs.'],
  ],
  who: [
    [
      'pronoun',
      'Asks which person, or introduces a relative clause about a person.',
      'The author who revised it.',
    ],
  ],
  whom: [
    [
      'pronoun',
      'The form of "who" used as the object of a verb or preposition.',
      'The editor to whom it was sent.',
    ],
  ],

  /* ---- prepositions ---- */
  of: [
    [
      'preposition',
      'Links a thing to what it belongs to, is part of, or is made from.',
      'The end of the chapter.',
    ],
  ],
  to: [
    [
      'preposition',
      'Marks the destination, recipient or limit of something.',
      'He walked to the window.',
    ],
    ['particle', 'Marks the plain form of a verb that follows.', 'She began to read.'],
  ],
  in: [
    [
      'preposition',
      'Marks something as inside a place, a period or a state.',
      'The reference is in the footnote.',
    ],
  ],
  on: [
    [
      'preposition',
      'Marks contact with a surface, or the day or topic something concerns.',
      'The note is on page four.',
    ],
  ],
  at: [
    ['preposition', 'Marks a precise point in space, time or scale.', 'The talk starts at noon.'],
  ],
  for: [
    [
      'preposition',
      'Marks a purpose, a recipient, a reason or a length of time.',
      'This copy is for you.',
    ],
    [
      'conjunction',
      'Introduces the reason for what was just said; formal in modern use.',
      'He said little, for the matter was settled.',
    ],
  ],
  with: [
    [
      'preposition',
      'Marks accompaniment, possession of a feature, or the means used.',
      'He wrote with a pencil.',
    ],
  ],
  from: [
    [
      'preposition',
      'Marks a starting point, an origin or a source.',
      'A quotation from the preface.',
    ],
  ],
  by: [
    [
      'preposition',
      'Marks who or what performed an action, a means, or a deadline.',
      'An essay by the translator.',
    ],
  ],
  about: [
    [
      'preposition',
      'Marks the subject of something, or an approximate amount.',
      'A book about tides.',
    ],
  ],
  as: [
    [
      'preposition',
      'Marks the role or capacity in which something is considered.',
      'He wrote as an outsider.',
    ],
    [
      'conjunction',
      'Introduces a comparison, a reason, or something happening at the same time.',
      'As the light faded, she stopped.',
    ],
  ],
  into: [
    [
      'preposition',
      'Marks movement to a position inside something.',
      'He folded it into the book.',
    ],
  ],
  onto: [
    ['preposition', 'Marks movement to a position on a surface.', 'She copied it onto a card.'],
  ],
  over: [
    [
      'preposition',
      'Marks a position above something, movement across it, or a span of time.',
      'Over the following week.',
    ],
  ],
  under: [
    [
      'preposition',
      'Marks a position below something, or being subject to it.',
      'Filed under the earlier title.',
    ],
  ],
  between: [
    [
      'preposition',
      'Marks a position or relation involving two separate points or parties.',
      'The gap between the editions.',
    ],
  ],
  among: [
    ['preposition', 'Marks a position within a group of three or more.', 'One opinion among many.'],
  ],
  against: [
    [
      'preposition',
      'Marks contact with a surface, or opposition to something.',
      'An argument against the reading.',
    ],
  ],
  during: [
    [
      'preposition',
      'Marks the period throughout which something happens.',
      'Quiet during the lecture.',
    ],
  ],
  through: [
    [
      'preposition',
      'Marks movement from one side of something to the other, or the means by which something happens.',
      'Learned through practice.',
    ],
  ],
  before: [
    ['preposition', 'Marks a point earlier in time or order.', 'Read the notice before signing.'],
  ],
  after: [['preposition', 'Marks a point later in time or order.', 'After the second chapter.']],
  without: [['preposition', 'Marks the absence of something.', 'He answered without hesitating.']],
  within: [
    [
      'preposition',
      'Marks something as inside a boundary, limit or period.',
      'Within the first ten pages.',
    ],
  ],
  upon: [
    [
      'preposition',
      'A formal equivalent of "on", often marking what something rests on or follows.',
      'Upon reflection, he agreed.',
    ],
  ],
  than: [
    [
      'conjunction',
      'Introduces the second part of a comparison.',
      'Shorter than the first edition.',
    ],
  ],

  /* ---- conjunctions ---- */
  and: [
    ['conjunction', 'Joins words, phrases or clauses of equal standing.', 'Theory and practice.'],
  ],
  or: [['conjunction', 'Offers an alternative between the parts it joins.', 'Print or screen.']],
  but: [
    [
      'conjunction',
      'Joins two parts while marking a contrast between them.',
      'Short but difficult.',
    ],
  ],
  nor: [
    [
      'conjunction',
      'Joins a second negative statement to a first.',
      'He neither wrote nor replied.',
    ],
  ],
  so: [
    [
      'conjunction',
      'Introduces a consequence of what was just said.',
      'The press closed, so the edition was never finished.',
    ],
  ],
  yet: [
    [
      'conjunction',
      'Joins a statement that is surprising after the one before it.',
      'Brief, yet complete.',
    ],
  ],
  if: [
    [
      'conjunction',
      'Introduces a condition on which the rest depends.',
      'If the text is unclear, check the notes.',
    ],
  ],
  because: [
    [
      'conjunction',
      'Introduces the reason for what was just said.',
      'It failed because it was rushed.',
    ],
  ],
  although: [
    [
      'conjunction',
      'Introduces something that makes the main statement unexpected.',
      'Although late, the volume sold well.',
    ],
  ],
  though: [
    [
      'conjunction',
      'A less formal equivalent of "although".',
      'Though brief, the preface is useful.',
    ],
  ],
  while: [
    [
      'conjunction',
      'Marks something happening at the same time, or sets up a contrast.',
      'While he read, she took notes.',
    ],
  ],
  unless: [
    ['conjunction', 'Introduces the exception that would prevent something.', 'Unless it rains.'],
  ],
  until: [
    [
      'preposition',
      'Marks the point in time at which something stops.',
      'He worked until midnight.',
    ],
  ],
  whether: [
    [
      'conjunction',
      'Introduces two or more possibilities being considered.',
      'Whether to revise or rewrite.',
    ],
  ],

  /* ---- auxiliary and modal verbs ---- */
  be: [
    [
      'auxiliary verb',
      'Links a subject to a description, or forms continuous and passive verb phrases.',
      'The work will be reprinted.',
    ],
  ],
  am: [['auxiliary verb', 'The form of "be" used with "I" in the present.', 'I am convinced.']],
  is: [
    [
      'auxiliary verb',
      'The form of "be" used with a singular subject in the present.',
      'The argument is familiar.',
    ],
  ],
  are: [
    [
      'auxiliary verb',
      'The form of "be" used with a plural subject, or with "you", in the present.',
      'The sources are listed.',
    ],
  ],
  was: [
    [
      'auxiliary verb',
      'The past form of "be" used with a singular subject.',
      'The author was unknown.',
    ],
  ],
  were: [
    [
      'auxiliary verb',
      'The past form of "be" used with a plural subject, or with "you".',
      'The pages were loose.',
    ],
  ],
  been: [
    [
      'auxiliary verb',
      'The form of "be" used after "have" to make a completed form.',
      'It has been revised.',
    ],
  ],
  being: [
    [
      'auxiliary verb',
      'The form of "be" used to make a continuous or passive form.',
      'The index is being rebuilt.',
    ],
  ],
  have: [
    [
      'auxiliary verb',
      'Combines with a past form to say that something is completed.',
      'They have finished.',
    ],
  ],
  has: [
    [
      'auxiliary verb',
      'The form of "have" used with a singular subject in the present.',
      'She has written three.',
    ],
  ],
  had: [
    [
      'auxiliary verb',
      'The past form of "have", used to place one event before another.',
      'He had left before dawn.',
    ],
  ],
  do: [
    [
      'auxiliary verb',
      'Forms questions and negatives, and adds emphasis, in the present.',
      'Do you have the second volume?',
    ],
  ],
  does: [
    [
      'auxiliary verb',
      'The form of "do" used with a singular subject in the present.',
      'It does not say.',
    ],
  ],
  did: [['auxiliary verb', 'The past form of "do".', 'Did the edition sell?']],
  will: [
    [
      'auxiliary verb',
      'Marks something as expected or intended in the future.',
      'The volume will appear in spring.',
    ],
  ],
  would: [
    [
      'auxiliary verb',
      'Marks something as conditional, habitual in the past, or politely tentative.',
      'He would read until dark.',
    ],
  ],
  shall: [
    [
      'auxiliary verb',
      'Marks a future intention or an obligation; formal in modern use.',
      'We shall return to this.',
    ],
  ],
  should: [
    ['auxiliary verb', 'Marks what is advisable or expected.', 'The reader should begin here.'],
  ],
  can: [
    [
      'auxiliary verb',
      'Marks ability, possibility or permission.',
      'The file can be opened offline.',
    ],
  ],
  could: [['auxiliary verb', 'The past or more tentative form of "can".', 'He could read Greek.']],
  may: [['auxiliary verb', 'Marks possibility or permission.', 'The term may be unfamiliar.']],
  might: [
    ['auxiliary verb', 'Marks a weaker possibility than "may".', 'It might be a later copy.'],
  ],
  must: [
    ['auxiliary verb', 'Marks obligation or a confident conclusion.', 'The date must be wrong.'],
  ],
  not: [
    [
      'particle',
      'Reverses the meaning of the verb or phrase it belongs to.',
      'The passage is not quoted.',
    ],
  ],
};

const build = (): ReadonlyMap<string, ClosedClassEntry> => {
  const entries = new Map<string, ClosedClassEntry>();

  for (const [key, definitions] of Object.entries(rows)) {
    entries.set(key, {
      key,
      senses: definitions.map(([partOfSpeech, definition, example]) => ({
        partOfSpeech,
        definition,
        examples: [example],
      })),
    });
  }

  return entries;
};

const ENTRIES = build();

/** The curated entry for a key, or `null`. */
export const closedClassEntry = (key: string): ClosedClassEntry | null => ENTRIES.get(key) ?? null;

/** Whether the curated layer covers a key. */
export const hasClosedClassEntry = (key: string): boolean => ENTRIES.has(key);

/** Every curated key, for tests and documentation. */
export const closedClassKeys = (): readonly string[] => [...ENTRIES.keys()].sort();
