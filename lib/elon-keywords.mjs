// elon-watch (KODING #25): keywords of one X post -> the words a pump.fun memecoin might be named after.
//
// PURE: no network, no clock, no randomness. Input is a normalized post (lib/x-source.mjs normalizePost):
//   { id, kind: "post" | "reply" | "quote" | "repost", text, refs: [{ type, id, text }],
//     media: [{ type, url, alt }], vision: [{ texts: [...], characters: [...] }] (optional, lib/elon-vision.mjs) }
// Output: [{ kw, norm, variants, reason, weight, source }] deduplicated by `norm` (the strongest
// reason kept, every reason listed in `reasons`), sorted by weight desc then norm.
//   kw       the words as written ("Dark MAGA")
//   norm     NFKC, lower case, a-z0-9 only, a leading "the" word dropped ("darkmaga")
//   variants norm plus its singular / plural form (matching uses all of them)
//   reason   cashtag | hashtag | quoted | caps | capitalized | short | shortWord | bigram | emoji |
//            vision (+ prefix "alt:" for image alt_text, "parent:" for the replied-to / quoted post)
//   weight   0..1, a rough prior of "this word is the coin" (cashtag 1 ... bigram 0.4); parent x 0.6
//   source   "post" | "alt" | "parent" | "vision"
//
// Extraction rules (text = post text with URLs, @mentions and "RT @x:" removed):
//   $cashtags, #hashtags, "quoted words" (1-4 words), ALL-CAPS words (>= 3 letters), Capitalized words
//   not at a sentence start; a very short post (<= 3 words) gives the whole post and each word;
//   adjacent non-stop-word bigrams joined; emoji -> word (EMOJI_WORDS); stop words and norms shorter
//   than MIN_LEN are dropped.

export const KEYWORDS_REV = 1;
export const MIN_LEN = 3;
export const SHORT_POST_WORDS = 3;

const WEIGHTS = { cashtag: 1, short: 1, shortWord: 0.9, hashtag: 0.8, quoted: 0.8, vision: 0.8, emoji: 0.7, caps: 0.6, capitalized: 0.5, bigram: 0.4 };
const SOURCE_FACTOR = { post: 1, alt: 0.9, vision: 1, parent: 0.6 };

// Emoji -> the meme word a coin would use. Small on purpose: only memes that keep coming back.
export const EMOJI_WORDS = new Map([
  ["🐸", "pepe"],
  ["🐶", "doge"],
  ["🐕", "doge"],
  ["🦮", "doge"],
  ["🚀", "rocket"],
  ["🌙", "moon"],
  ["🌕", "moon"],
  ["🔥", "fire"],
  ["💎", "diamond"],
  ["🦍", "ape"],
  ["🐒", "monkey"],
  ["🐱", "cat"],
  ["🐈", "cat"],
  ["🪐", "saturn"],
  ["👽", "alien"],
  ["🤖", "robot"],
  ["🦅", "eagle"],
  ["🇺🇸", "america"],
  ["💩", "poop"],
  ["🍆", "eggplant"],
  ["🧠", "brain"],
  ["👻", "ghost"],
  ["🐳", "whale"],
  ["🐂", "bull"],
  ["🐻", "bear"],
  ["🍑", "peach"],
  ["🌮", "taco"],
  ["🍕", "pizza"],
  ["🎯", "target"],
  ["⚡", "lightning"],
]);

// English filler + Elon's frequent one-word replies. Compared against the norm.
export const STOP_WORDS = new Set(
  (
    "the a an and or but if then than that this these those there here where when what which who whom whose why how " +
    "is are was were be been being am do does did done doing have has had having will would shall should can could may might must " +
    "i me my mine we us our ours you your yours he him his she her hers it its they them their theirs " +
    "of in on at to for from by with without about into onto over under up down out off again further once " +
    "all any both each few more most other some such no nor not only own same so too very just now also still even ever " +
    "yes yeah yep yup no nope ok okay true false wow exactly indeed absolutely definitely interesting concerning great good bad " +
    "lol lmao haha hahaha rofl omg wtf nice cool sure right wrong thanks thank please maybe probably actually literally really " +
    "major big huge important amazing incredible insane crazy wild super much many lot lots thing things something nothing everything " +
    "people person time times year years day days today tomorrow yesterday week month new old first last next way ways part " +
    "make makes made get gets got go goes going gone come comes came see sees saw seen know knows knew think thinks thought say says said " +
    "want wants need needs like likes look looks use used work works working one two three four five ten hundred thousand million billion " +
    "true accurate correct fair based exactly hmm hmmm uh oh ah aha mr mrs ms dr st vs via amp rt"
  )
    .split(/\s+/)
    .filter(Boolean),
);

const URL_RE = /\bhttps?:\/\/\S+/gi;
const MENTION_RE = /(^|[^\w])@\w{1,15}/g;
const RT_RE = /^RT\s+@\w{1,15}:\s*/i;
const CASHTAG_RE = /(^|[^\w$])\$([A-Za-z][A-Za-z0-9_]{1,19})\b/g;
const HASHTAG_RE = /(^|[^\w#])#([\p{L}\p{N}_]{2,40})/gu;
const QUOTED_RE = /["“”«»]([^"“”«»\n]{2,60})["“”«»]/g;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

// NFKC, lower case, a-z0-9 only.
export function normWord(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// A phrase ("The Dark MAGA") -> "darkmaga": a leading "the" word is dropped, the rest joined.
export function normPhrase(s) {
  const words = String(s ?? "").match(WORD_RE) || [];
  const w = words.map(normWord).filter(Boolean);
  if (w.length > 1 && w[0] === "the") w.shift();
  return w.join("");
}

// The singular / plural variant of a norm (both kept for matching).
export function variantsOf(norm) {
  const out = [norm];
  if (norm.length >= 5 && norm.endsWith("ies")) out.push(norm.slice(0, -3) + "y");
  else if (norm.length >= 5 && /(ses|xes|zes|ches|shes)$/.test(norm)) out.push(norm.slice(0, -2));
  else if (norm.length >= 4 && norm.endsWith("s") && !norm.endsWith("ss")) out.push(norm.slice(0, -1));
  else if (norm.endsWith("ss") || norm.endsWith("x")) out.push(norm + "es");
  else if (norm.length >= MIN_LEN) out.push(norm + "s");
  return [...new Set(out)];
}

export function cleanText(text) {
  return String(text ?? "")
    .replace(RT_RE, "")
    .replace(URL_RE, " ")
    .replace(MENTION_RE, "$1 ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isStop(norm) {
  return !norm || norm.length < MIN_LEN || STOP_WORDS.has(norm) || /^\d+$/.test(norm);
}

// Candidates of one text block. `source` decides the weight factor and the reason prefix.
function fromText(text, source, add) {
  const prefix = source === "alt" ? "alt:" : source === "parent" ? "parent:" : "";
  const t = cleanText(text);
  for (const m of t.matchAll(CASHTAG_RE)) add(m[2], `${prefix}cashtag`, WEIGHTS.cashtag, source, true);
  for (const m of t.matchAll(HASHTAG_RE)) add(m[2], `${prefix}hashtag`, WEIGHTS.hashtag, source, true);
  for (const m of t.matchAll(QUOTED_RE)) {
    const inner = m[1].trim();
    const n = (inner.match(WORD_RE) || []).length;
    if (n >= 1 && n <= 4) add(inner, `${prefix}quoted`, WEIGHTS.quoted, source);
  }
  for (const [emoji, word] of EMOJI_WORDS) if (t.includes(emoji)) add(word, `${prefix}emoji`, WEIGHTS.emoji, source, true);

  // words without the cashtag / hashtag sigils (those were taken above)
  const plain = t.replace(CASHTAG_RE, "$1 ").replace(HASHTAG_RE, "$1 ");
  const words = [];
  // sentence starts: the first word and any word after . ! ? or a line break
  for (const sentence of plain.split(/[.!?…\n]+/)) {
    let first = true;
    for (const m of sentence.matchAll(WORD_RE)) {
      words.push({ w: m[0].replace(/['’]s$/i, ""), start: first });
      first = false;
    }
  }
  const content = words.filter((x) => !isStop(normWord(x.w)));
  if (words.length > 0 && words.length <= SHORT_POST_WORDS && content.length > 0) {
    add(words.map((x) => x.w).join(" "), `${prefix}short`, WEIGHTS.short, source);
    for (const x of content) add(x.w, `${prefix}shortWord`, WEIGHTS.shortWord, source);
  }
  for (const x of words) {
    const letters = x.w.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) add(x.w, `${prefix}caps`, WEIGHTS.caps, source);
    else if (!x.start && /^\p{Lu}/u.test(x.w)) add(x.w, `${prefix}capitalized`, WEIGHTS.capitalized, source);
  }
  for (let i = 0; i + 1 < words.length; i++) {
    const a = normWord(words[i].w);
    const b = normWord(words[i + 1].w);
    if (isStop(a) || isStop(b)) continue;
    add(`${words[i].w} ${words[i + 1].w}`, `${prefix}bigram`, WEIGHTS.bigram, source);
  }
}

// post -> keywords (see the header).
export function extractKeywords(post) {
  const byNorm = new Map();
  const add = (kw, reason, weight, source, single = false) => {
    const norm = single ? normWord(kw) : normPhrase(kw);
    if (isStop(norm)) return;
    const w = Math.round(weight * (SOURCE_FACTOR[source] ?? 1) * 100) / 100;
    const cur = byNorm.get(norm);
    if (!cur) {
      byNorm.set(norm, { kw: String(kw).trim(), norm, variants: variantsOf(norm), reason, weight: w, source, reasons: [reason] });
      return;
    }
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    if (w > cur.weight) Object.assign(cur, { kw: String(kw).trim(), reason, weight: w, source });
  };
  if (!post) return [];
  // a repost's own text is "RT @x: <truncated>": the reposted post's full text is the content
  const repost = post.kind === "repost";
  const own = repost ? (post.refs || []).find((r) => r.type === "retweeted")?.text ?? post.text : post.text;
  fromText(own, "post", add);
  for (const m of post.media || []) if (m?.alt) fromText(m.alt, "alt", add);
  for (const v of post.vision || []) {
    for (const s of v?.texts || []) add(s, "vision", WEIGHTS.vision, "vision");
    for (const s of v?.characters || []) add(s, "vision", WEIGHTS.vision, "vision");
  }
  if (!repost) for (const r of post.refs || []) if (r?.text && (r.type === "replied_to" || r.type === "quoted")) fromText(r.text, "parent", add);
  return [...byNorm.values()].sort((a, b) => b.weight - a.weight || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
}
