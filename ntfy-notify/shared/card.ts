/** Versioned, producer-agnostic content type understood by the ntfy Android client. */
export const CARD_CONTENT_TYPE = "application/vnd.ntfy.card+json;v=1";

export const CARD_VERSION = 1;

export interface CardDocument {
  version: 1;
  blocks: CardBlock[];
}

/** Tones the Android client recognizes; anything else falls back to neutral. */
export type CardTone = "success" | "error" | "warning" | "neutral";

export type CardBlock =
  | { type: "heading"; text: string }
  | { type: "text"; text: string; markdown?: boolean }
  | { type: "markdown"; text: string }
  | { type: "section"; label: string; body: string; markdown?: boolean }
  | { type: "kv"; items: { label: string; value: string }[] }
  | { type: "status"; label: string; tone?: CardTone }
  | { type: "link"; label: string; url: string }
  | { type: "divider" };

const encoder = new TextEncoder();

export function cardByteLength(card: CardDocument): number {
  return encoder.encode(JSON.stringify(card)).byteLength;
}

/** Conservative ceiling: the daemon's JSON envelope and ntfy's own overhead must fit under 16 KiB too. */
export const CARD_BYTE_LIMIT = 15_500;

export function truncateUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let result = "";
  for (const char of text) {
    const next = result + char;
    if (encoder.encode(next).byteLength > maxBytes - 3) break;
    result = next;
  }
  return `${result}…`;
}

/**
 * Serialize a card while keeping it valid JSON under ntfy's message-size limit.
 *
 * Stock ntfy stores the card as the plain message body, so the whole JSON string must stay under
 * the server's message-size limit. Blocks are dropped from the end first (least important detail
 * last), then long field values are shortened; the document is only ever handed back as valid JSON.
 * Returns null when even a minimal card cannot fit, so the caller can fall back to plain text.
 */
export function serializeCard(card: CardDocument, limit = CARD_BYTE_LIMIT): string | null {
  const built = buildCard(card, limit);
  return built === null ? null : JSON.stringify(built);
}

function buildCard(card: CardDocument, limit: number): CardDocument | null {
  const candidate: CardDocument = { version: CARD_VERSION, blocks: card.blocks.map(cloneBlock) };
  if (fits(candidate, limit)) return candidate;

  // Pass 1: drop whole blocks from the end, keeping the heading and first block.
  while (candidate.blocks.length > 2 && !fits(candidate, limit)) candidate.blocks.pop();
  if (fits(candidate, limit)) return candidate;

  // Pass 2: shorten long values, then drop again down to a single block.
  for (const block of candidate.blocks) hardCapBlock(block);
  while (candidate.blocks.length > 1 && !fits(candidate, limit)) candidate.blocks.pop();
  if (fits(candidate, limit)) return candidate;

  // Pass 3: a single block may still be too long; keep only its first line.
  candidate.blocks[0]!.type === "kv" || hardCapBlock(candidate.blocks[0]!, true);
  if (fits(candidate, limit)) return candidate;

  const minimal: CardDocument = {
    version: CARD_VERSION,
    blocks: [{ type: "status", label: "通知内容过长，已压缩", tone: "warning" }],
  };
  return fits(minimal, limit) ? minimal : null;
}

function fits(card: CardDocument, limit: number): boolean {
  return cardByteLength(card) <= limit;
}

function cloneBlock(block: CardBlock): CardBlock {
  if (block.type === "kv") return { ...block, items: block.items.map((item) => ({ ...item })) };
  return { ...block };
}

function hardCapBlock(block: CardBlock, aggressive = false): void {
  const textLimit = aggressive ? 120 : 2_000;
  switch (block.type) {
    case "heading":
      block.text = truncateUtf8(block.text, aggressive ? 60 : 200);
      return;
    case "text":
    case "markdown":
      block.text = truncateUtf8(block.text, textLimit);
      return;
    case "section":
      block.label = truncateUtf8(block.label, aggressive ? 40 : 120);
      block.body = truncateUtf8(block.body, textLimit);
      return;
    case "status":
      block.label = truncateUtf8(block.label, aggressive ? 60 : 200);
      return;
    case "link":
      block.label = truncateUtf8(block.label, aggressive ? 60 : 200);
      return;
    case "kv":
      block.items = block.items.slice(0, aggressive ? 4 : 12).map((item) => ({
        label: truncateUtf8(item.label, 120),
        value: truncateUtf8(item.value, aggressive ? 120 : 500),
      }));
      return;
    default:
      return;
  }
}
