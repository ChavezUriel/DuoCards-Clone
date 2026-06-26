// The 3 hand-authored starter decks (originally from backend/app/db.py).
// Shared by generate_seed.cjs (compiles seed.sql) and generate_cards.cjs
// (so the generator's "existing decks" view matches the seed compiler's).
module.exports = [
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
