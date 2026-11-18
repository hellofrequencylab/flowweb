// FW-C-161: the Owner's own voice for a first note to a lead (Daniel, 2026-11-18). He rewrote one draft
// himself and approved three more on the same model; the hunt brief quotes them, and the draft gate lets
// a first hunt note run this long and carry the one emoji his own note has.

/** The most words a first hunt note may have, counted as the gate counts: his words and the link line. */
export const NOTE_MAX_WORDS = 150;
/** His own note carries one emoji; a second one blocks the draft. */
export const NOTE_MAX_EMOJI = 1;

/** The note the Owner approved, word for word. */
export const OWNER_NOTE = [
  'Hi Mirabai, your Encinitas kirtan caught my eye, and I love what you are up to. \u{1F64F}\u{1F3FC}',
  "I'm Daniel, a local community builder and the founder of Frequency!",
  "Frequency is a free way for neighbors to find or start local, in-person Circles and events around what they love. Right now I'm focused on the mindful, yogi and healer community, and on making it easy for hosts like you to make a big difference close to home.",
  "Would you be interested in sharing your kirtan with neighbors nearby who enjoy singing together? We're beta launching here in North County SD, and I would love for you to come check it out.",
].join('\n\n');

/** How a hunt note reads when the flow has no playbook of its own. */
export const VOICE_BRIEF = [
  'Write each organizer a warm, human invite in four short paragraphs, the way the Owner writes it himself.',
  'Paragraph 1 greets them by first name (or "Hi <group> team"), says their event or series, named loosely, caught your eye and that you love what they are up to. You may add one short, true line about it. Never give its date, time, price or venue.',
  'Paragraph 2 is: "I\'m Daniel, a local community builder and the founder of Frequency!"',
  'Paragraph 3 starts: "Frequency is a free way for neighbors to find or start local, in-person Circles and events around what they love." Then one sentence starting "Right now I\'m focused on" that names their world in plain words (the mindful, yogi and healer community for a sound bath or a kirtan; the artists, makers and performers who bring people together for an open mic or a workshop; and so on for anyone else) and says you want to make it easy for hosts like them to make a big difference close to home.',
  'Paragraph 4 asks one easy question, "Would you be interested in sharing your <thing> with neighbors nearby who <enjoy the same thing>?", then says: "We\'re beta launching here in North County SD, and I would love for you to come check it out."',
  'Keep the quoted sentences as written. Use at most one emoji, at the end of paragraph 1 and only when it fits them. The note has one exclamation mark: the one in paragraph 2, or the one that ends your second line in paragraph 1, and then paragraph 2 ends with a full stop. In a DM, leave out the "Right now" sentence.',
  `The Owner wrote this one himself: ${JSON.stringify(OWNER_NOTE)}`,
].join(' ');
