import type * as React from "react";

const EMOJI_RUN_SOURCE =
  "(?:[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2}|(?:\\p{Emoji_Presentation}\\uFE0F?|\\p{Extended_Pictographic}\\uFE0F)[\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D(?:\\p{Emoji_Presentation}\\uFE0F?|\\p{Extended_Pictographic}\\uFE0F?|\\p{Emoji}\\uFE0F?)[\\u{1F3FB}-\\u{1F3FF}]?)*|[\\uFE0F\\u{1F3FB}-\\u{1F3FF}])+";
const EMOJI_TEST_RE = new RegExp(EMOJI_RUN_SOURCE, "u");
const EMOJI_MATCH_RE = new RegExp(EMOJI_RUN_SOURCE, "gu");

/**
 * Wraps emoji, VS16, and skin-tone modifier runs in `.emoji-run` so macOS WebKit
 * resolves them directly in an emoji font instead of scanning the system font registry.
 */
export function renderEmojiSafeText(text: string): React.ReactNode {
  if (!text || !EMOJI_TEST_RE.test(text)) {
    return text;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(EMOJI_MATCH_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    nodes.push(
      <span key={start} className="emoji-run">
        {match[0]}
      </span>,
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
