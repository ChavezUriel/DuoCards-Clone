// Generates supabase/seed.sql for the global starter decks.
// Faithfully mirrors backend/app/db.py _seed_database: process SEED_DECKS first,
// then the deck_expansions*.json files (sorted by filename), merging by slug and
// de-duplicating cards by (spanish, english) case-insensitively (first wins).
//
// Run: node supabase/scripts/generate_seed.cjs
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../seed_data');
const OUT = path.resolve(__dirname, '../seed.sql');

// The 3 hand-authored starter decks from backend/app/db.py (rich cards).
const SEED_DECKS = [
  {
    slug: 'basics', title: 'English Basics',
    description: 'Everyday words and short expressions for beginners.',
    cards: [
      { spanish: 'Hola', english: 'Hello', part_of_speech: 'interjection', definition_en: 'A word used when meeting someone or starting a conversation.', main_translations_es: ['hola', 'buenas'], collocations: ['say hello', 'hello everyone', 'hello there'], example_sentence: 'Hello, welcome to our English class.', example_es: 'Hola, ¿cómo estás?', example_en: 'Hello, how are you?' },
      { spanish: 'Gracias', english: 'Thank you', part_of_speech: 'expression', definition_en: 'A polite expression used to show gratitude.', main_translations_es: ['gracias', 'muchas gracias'], collocations: ['thank you very much', 'thank you for', 'say thank you'], example_sentence: 'Thank you for coming today.', example_es: 'Gracias por tu ayuda.', example_en: 'Thank you for your help.' },
      { spanish: 'Por favor', english: 'Please', part_of_speech: 'adverb', definition_en: 'A polite word used when asking for something or making a request.', main_translations_es: ['por favor'], collocations: ['please help', 'please sit down', 'yes, please'], example_sentence: 'Please close the window before you leave.', example_es: 'Por favor, abre la puerta.', example_en: 'Please open the door.' },
      { spanish: 'Buenos días', english: 'Good morning', part_of_speech: 'expression', definition_en: 'A greeting used in the early part of the day.', main_translations_es: ['buenos días'], collocations: ['say good morning', 'good morning everyone', 'good morning sir'], example_sentence: 'Good morning, how was your weekend?', example_es: 'Buenos días, profesora.', example_en: 'Good morning, teacher.' },
      { spanish: '¿Cuánto cuesta?', english: 'How much does it cost?', part_of_speech: 'question', definition_en: 'A question used to ask for the price of something.', main_translations_es: ['¿cuánto cuesta?', '¿qué precio tiene?'], collocations: ['how much does it cost', 'cost too much', 'cost a lot'], example_sentence: 'How much does it cost to travel by train?', example_es: '¿Cuánto cuesta este libro?', example_en: 'How much does this book cost?' },
    ],
  },
  {
    slug: 'daily-life', title: 'Daily Life',
    description: 'Useful vocabulary for routines, places, and simple actions.',
    cards: [
      { spanish: 'Trabajo', english: 'Work', part_of_speech: 'noun / verb', definition_en: 'Activity you do to earn money, or the act of doing a job.', main_translations_es: ['trabajo', 'trabajar'], collocations: ['go to work', 'work hard', 'work from home'], example_sentence: 'She goes to work at eight every morning.', example_es: 'Voy al trabajo en autobús.', example_en: 'I go to work by bus.' },
      { spanish: 'Comida', english: 'Food', part_of_speech: 'noun', definition_en: 'Things that people or animals eat.', main_translations_es: ['comida', 'alimento'], collocations: ['fresh food', 'food market', 'food delivery'], example_sentence: 'The food at this restaurant is excellent.', example_es: 'La comida está lista.', example_en: 'The food is ready.' },
      { spanish: 'Casa', english: 'House', part_of_speech: 'noun', definition_en: 'A building where people live, usually with a family.', main_translations_es: ['casa', 'hogar'], collocations: ['house keys', 'house party', 'go home to the house'], example_sentence: 'Their house is near the river.', example_es: 'Mi casa está cerca.', example_en: 'My house is nearby.' },
      { spanish: 'Caminar', english: 'To walk', part_of_speech: 'verb', definition_en: 'To move forward on foot at a regular speed.', main_translations_es: ['caminar', 'andar'], collocations: ['walk home', 'walk slowly', 'walk in the park'], example_sentence: 'We walk to school when the weather is nice.', example_es: 'Me gusta caminar por el parque.', example_en: 'I like to walk in the park.' },
      { spanish: 'Necesito ayuda', english: 'I need help', part_of_speech: 'expression', definition_en: 'A phrase used when you require support or assistance.', main_translations_es: ['necesito ayuda', 'me hace falta ayuda'], collocations: ['need help with', 'ask for help', 'get help'], example_sentence: 'I need help with this exercise.', example_es: 'Necesito ayuda con mi tarea.', example_en: 'I need help with my homework.' },
    ],
  },
  {
    slug: 'travel', title: 'Travel Phrases',
    description: 'Short phrases for transport, directions, and common travel moments.',
    cards: [
      { spanish: 'Aeropuerto', english: 'Airport', part_of_speech: 'noun', definition_en: 'A place where airplanes arrive and leave.', main_translations_es: ['aeropuerto'], collocations: ['airport terminal', 'airport bus', 'go to the airport'], example_sentence: 'We arrived at the airport two hours early.', example_es: 'El aeropuerto está lejos del centro.', example_en: 'The airport is far from downtown.' },
      { spanish: '¿Dónde está la estación?', english: 'Where is the station?', part_of_speech: 'question', definition_en: 'A question used to ask for the location of a station.', main_translations_es: ['¿dónde está la estación?'], collocations: ['train station', 'bus station', 'station entrance'], example_sentence: 'Excuse me, where is the station from here?', example_es: 'Disculpa, ¿dónde está la estación?', example_en: 'Excuse me, where is the station?' },
      { spanish: 'Billete', english: 'Ticket', part_of_speech: 'noun', definition_en: 'A piece of paper or digital document that gives you permission to travel or enter a place.', main_translations_es: ['billete', 'boleto', 'entrada'], collocations: ['buy a ticket', 'train ticket', 'return ticket'], example_sentence: 'I bought a ticket online yesterday.', example_es: 'Necesito un billete para Londres.', example_en: 'I need a ticket to London.' },
      { spanish: 'Maleta', english: 'Suitcase', part_of_speech: 'noun', definition_en: 'A case used for carrying clothes and personal items when traveling.', main_translations_es: ['maleta'], collocations: ['pack a suitcase', 'heavy suitcase', 'carry a suitcase'], example_sentence: 'Her suitcase is too heavy to lift.', example_es: 'Mi maleta es negra.', example_en: 'My suitcase is black.' },
      { spanish: 'Estoy perdido', english: 'I am lost', part_of_speech: 'expression', definition_en: 'A phrase used to say that you do not know where you are or where to go.', main_translations_es: ['estoy perdido', 'no sé dónde estoy'], collocations: ['feel lost', 'get lost', 'completely lost'], example_sentence: 'I am lost, so I need to check the map.', example_es: 'Estoy perdido, ¿puedes ayudarme?', example_en: 'I am lost, can you help me?' },
    ],
  },
];

function optText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const item of v) {
    const s = optText(item);
    if (s === null) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
function normCard(card, deckTitle) {
  const spanish = optText(card.spanish ?? card.prompt_es);
  const english = optText(card.english ?? card.answer_en);
  if (!spanish || !english) throw new Error('card missing spanish/english: ' + JSON.stringify(card));
  return {
    spanish_text: spanish,
    english_text: english,
    section_name: optText(card.section_name) ?? deckTitle,
    part_of_speech: optText(card.part_of_speech),
    definition_en: optText(card.definition_en),
    main_translations_es: normList(card.main_translations_es),
    collocations: normList(card.collocations),
    example_sentence: optText(card.example_sentence),
    example_es: optText(card.example_es),
    example_en: optText(card.example_en),
  };
}

// Build the ordered source list: SEED_DECKS, then expansion files sorted by name.
const sources = [...SEED_DECKS];
const files = fs.readdirSync(DATA_DIR).filter(f => /^deck_expansions.*\.json$/.test(f)).sort();
for (const f of files) {
  const payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  if (!Array.isArray(payload)) throw new Error(f + ' must be a list');
  sources.push(...payload);
}

// Merge by slug, de-dupe cards by (spanish, english).
const decks = new Map(); // slug -> {slug,title,description,language_from,language_to,cards:[],seen:Set}
for (const src of sources) {
  const slug = optText(src.slug);
  const title = optText(src.title);
  const description = optText(src.description);
  if (!slug || !title || !description) throw new Error('deck missing slug/title/description: ' + slug);
  if (!Array.isArray(src.cards) || src.cards.length === 0) throw new Error('deck has no cards: ' + slug);
  let entry = decks.get(slug);
  if (!entry) {
    entry = { slug, title, description, language_from: optText(src.language_from) || 'es', language_to: optText(src.language_to) || 'en', cards: [], seen: new Set() };
    decks.set(slug, entry);
  }
  for (const c of src.cards) {
    const nc = normCard(c, entry.title);
    const key = nc.spanish_text.toLowerCase() + ' ' + nc.english_text.toLowerCase();
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    entry.cards.push(nc);
  }
}

const sq = (s) => s === null ? 'null' : "'" + String(s).replace(/'/g, "''") + "'";
const jsonLit = (obj) => "'" + JSON.stringify(obj).replace(/'/g, "''") + "'";

let sql = `-- AUTO-GENERATED by supabase/scripts/generate_seed.cjs — do not edit by hand.\n`;
sql += `-- Global starter decks (user_id IS NULL). Idempotent: safe to re-run.\n\n`;
sql += `begin;\n\n`;

let totalCards = 0;
for (const deck of decks.values()) {
  totalCards += deck.cards.length;
  sql += `-- ${deck.slug} (${deck.cards.length} cards)\n`;
  sql += `insert into public.decks (slug, title, description, language_from, language_to)\n`;
  sql += `values (${sq(deck.slug)}, ${sq(deck.title)}, ${sq(deck.description)}, ${sq(deck.language_from)}, ${sq(deck.language_to)})\n`;
  sql += `on conflict (slug) do nothing;\n\n`;

  const cardsJson = deck.cards.map(c => ({
    spanish_text: c.spanish_text,
    english_text: c.english_text,
    section_name: c.section_name,
    part_of_speech: c.part_of_speech,
    definition_en: c.definition_en,
    main_translations_es: c.main_translations_es,
    collocations: c.collocations,
    example_sentence: c.example_sentence,
    example_es: c.example_es,
    example_en: c.example_en,
  }));

  sql += `insert into public.cards (deck_id, spanish_text, english_text, is_enabled, generation_phase, generation_metadata, section_name, part_of_speech, definition_en, main_translations_es, collocations, example_sentence, example_es, example_en)\n`;
  sql += `select dk.id, x.spanish_text, x.english_text, true, 'refined', '{}'::jsonb, x.section_name, x.part_of_speech, x.definition_en,\n`;
  sql += `       coalesce(x.main_translations_es, '[]'::jsonb), coalesce(x.collocations, '[]'::jsonb), x.example_sentence, x.example_es, x.example_en\n`;
  sql += `from (select id from public.decks where slug = ${sq(deck.slug)}) dk\n`;
  sql += `cross join jsonb_to_recordset(${jsonLit(cardsJson)}::jsonb) as x(\n`;
  sql += `  spanish_text text, english_text text, section_name text, part_of_speech text, definition_en text,\n`;
  sql += `  main_translations_es jsonb, collocations jsonb, example_sentence text, example_es text, example_en text\n`;
  sql += `)\n`;
  sql += `where not exists (\n`;
  sql += `  select 1 from public.cards c2\n`;
  sql += `  where c2.deck_id = dk.id\n`;
  sql += `    and lower(c2.spanish_text) = lower(x.spanish_text)\n`;
  sql += `    and lower(c2.english_text) = lower(x.english_text)\n`;
  sql += `);\n\n`;
}

sql += `commit;\n`;

fs.writeFileSync(OUT, sql, 'utf8');
console.log(`Wrote ${OUT}`);
console.log(`Decks: ${decks.size}, total cards: ${totalCards}, file size: ${(sql.length / 1024).toFixed(1)} KB`);
for (const deck of decks.values()) console.log(`  ${deck.slug}: ${deck.cards.length}`);
