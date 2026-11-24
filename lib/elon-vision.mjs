// elon-watch (KODING #25): OPTIONAL slow path — read the text and the meme characters of an image
// attached to a post with Claude (ELON_VISION=1; default off). Never on the fast path: the caller fires
// it and goes on; its keywords arrive later as a separate elon_kw batch (reason "vision").
//
// One request per image: model claude-haiku-5-5, ELON_VISION_TIMEOUT_MS (default 4000), no retries,
// the image passed by URL (pbs.twimg.com), the answer constrained to JSON
//   { "texts": [ caption / visible words ], "characters": [ meme characters, e.g. "pepe" ] }
// by structured outputs. The API key comes from lib/config.mjs (ANTHROPIC_API_KEY) and is never
// logged. `client` is injectable (tests use a stub; no test touches the network).
// The SDK is imported lazily here (PROMPT N6): the bot imports this module only with ELON_VISION=1, and
// a stub client never loads the SDK at all.

export const VISION_MODEL = "claude-haiku-5-5";
export const DEFAULT_VISION_TIMEOUT_MS = 4000;

const SCHEMA = {
  type: "object",
  properties: {
    texts: { type: "array", items: { type: "string" } },
    characters: { type: "array", items: { type: "string" } },
  },
  required: ["texts", "characters"],
  additionalProperties: false,
};

const PROMPT =
  "This image was attached to a post on X. List (1) every word or short phrase of text visible in the image " +
  "(captions, labels, signs; at most 10, each at most 4 words) in `texts`, and (2) the internet meme characters " +
  "or famous animals / mascots shown (for example pepe, doge, wojak), lower case, at most 5, in `characters`. " +
  "Empty arrays when there are none.";

export async function createVisionClient({ apiKey, client = null, timeoutMs = DEFAULT_VISION_TIMEOUT_MS } = {}) {
  if (client) return { client, timeoutMs, APIError: null };
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (needed by ELON_VISION=1)");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return { client: new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs }), timeoutMs, APIError: Anthropic.APIError };
}

// imageUrl -> { texts, characters, latencyMs, error } — never throws.
export async function readImage(vc, imageUrl, { now = () => Date.now() } = {}) {
  const t0 = now();
  try {
    const res = await vc.client.messages.create(
      {
        model: VISION_MODEL,
        max_tokens: 512,
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: imageUrl } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
      { timeout: vc.timeoutMs, maxRetries: 0 },
    );
    const latencyMs = now() - t0;
    if (res.stop_reason === "refusal") return { texts: [], characters: [], latencyMs, error: "refusal" };
    const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const j = JSON.parse(text);
    const clean = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, 10) : []);
    return { texts: clean(j.texts), characters: clean(j.characters), latencyMs, error: null };
  } catch (e) {
    const name = vc.APIError && e instanceof vc.APIError ? `api ${e.status ?? ""}`.trim() : e?.name === "SyntaxError" ? "bad-json" : e?.name || "error";
    return { texts: [], characters: [], latencyMs: now() - t0, error: name };
  }
}
