// Short branch-name generation from a free-form user prompt. Backed by
// claude-haiku-4-5 via the Anthropic Messages API. Returns null when the
// API key isn't configured, the call fails/times out, or the response
// isn't shaped like a usable kebab-case name — callers are expected to
// fall back to a heuristic slug in those cases.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 10_000;
const MAX_INPUT_CHARS = 500;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,4}$/;

const SYSTEM = [
  "You name git branches.",
  "Reply with ONLY a kebab-case branch name: 2–4 lowercase words,",
  "characters limited to a-z / 0-9 / -, max 24 characters total.",
  "No explanation, no quotes, no slashes, no leading or trailing punctuation.",
].join(" ");

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export async function generateBranchName(text: string): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const input = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return null;

  try {
    const res = await c.messages.create(
      {
        model: MODEL,
        max_tokens: 24,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: "user", content: input }],
      },
      { timeout: TIMEOUT_MS },
    );
    const first = res.content[0];
    if (!first || first.type !== "text") return null;
    const name = first.text.trim().toLowerCase();
    if (name.length > 24) return null;
    return NAME_PATTERN.test(name) ? name : null;
  } catch {
    return null;
  }
}
