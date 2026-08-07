// Prompts for the "let AI help me write the spec" step.
//
// This is the cheap part of the workflow — two or three calls before any card
// is generated — and it is where a run is won or lost: the spec text is copied
// into every downstream prompt as `deck` context, so a vague topic produces a
// vague deck. The assistant turns a sentence into a complete spec, and can
// critique one the user wrote by hand.

import { DIFFICULTIES } from './deckSpec';

const SPEC_FIELDS = {
  title: 'string',
  description: 'string',
  topic: 'string',
  difficulty: `one of: ${DIFFICULTIES.join(' | ')}`,
  learner_profile: 'string',
  generation_notes: 'string',
  target_card_count: 0,
  sections: [
    { name: 'string', communicative_goal: 'string', lexical_focus: ['string'], target_card_count: 0 },
  ],
};

const SPEC_FIELD_RULES = [
  'title: 2–4 words, what a learner would call this deck.',
  'description: ONE sentence, concrete, learner-facing — it is shown on the deck card.',
  'topic: the subject matter in the learner\'s terms, e.g. "beginner English for pharmacy visits".',
  'learner_profile: who studies this deck and why they need it.',
  'generation_notes: one or two short instructions that steer word choice (register, region, what to avoid).',
  'sections: 2 to 6 communicatively distinct sections whose target_card_count values sum to target_card_count.',
  'Each section needs 3 to 8 concrete English lexical_focus keywords.',
  'Return JSON only, no commentary or markdown.',
];

// Plain-language idea -> a complete spec the form can render.
export function specDraftPrompt(idea, { targetCardCount = 20, planSections = true } = {}) {
  const system =
    'You turn a rough idea into a precise specification for a Spanish to English flashcard deck. ' +
    'Return JSON only.';
  const user = JSON.stringify({
    task: 'Write a deck specification from the learner\'s idea.',
    idea: String(idea ?? '').slice(0, 2000),
    target_card_count: targetCardCount,
    required_output: planSections ? SPEC_FIELDS : { ...SPEC_FIELDS, sections: [] },
    rules: [
      'Fill every field; never leave one empty or echo the idea verbatim.',
      `Use exactly ${targetCardCount} for target_card_count.`,
      ...(planSections ? [] : ['Return an empty sections array — the section plan is made later.']),
      ...SPEC_FIELD_RULES,
    ],
  });
  return { system, user, temperature: 0.4 };
}

// Critique + a revised spec. `notes` are shown to the user next to a
// one-click "apply" of the revision.
export function specRefinePrompt(spec, instruction) {
  const system =
    'You review specifications for Spanish to English flashcard decks and improve them. Return JSON only.';
  const user = JSON.stringify({
    task: 'Review this deck specification and return an improved version.',
    current_spec: spec,
    user_instruction: String(instruction ?? '').slice(0, 1000) || 'Make it more specific and teachable.',
    required_output: { notes: ['string'], spec: SPEC_FIELDS },
    rules: [
      'notes: 2 to 5 short observations about what you changed and why, addressed to the deck author.',
      'spec: the complete improved specification — every field present, not a diff.',
      'Honour user_instruction; keep the author\'s intent and language choice.',
      'Do not change target_card_count unless the instruction asks for it.',
      ...SPEC_FIELD_RULES,
    ],
  });
  return { system, user, temperature: 0.3 };
}
