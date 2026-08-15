export type ComposerSuggestionMode =
  | { readonly kind: "none" }
  | {
      readonly kind: "command";
      readonly query: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "reference";
      readonly query: string;
      readonly start: number;
      readonly end: number;
    };

export function parseComposerSuggestionMode(
  text: string,
  cursor: number,
): ComposerSuggestionMode {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  let start = safeCursor;
  while (start > 0 && !isWhitespace(text[start - 1] ?? "")) {
    start -= 1;
  }
  let end = safeCursor;
  while (end < text.length && !isWhitespace(text[end] ?? "")) {
    end += 1;
  }
  const token = text.slice(start, end);
  const trigger = token[0];
  if (
    (trigger !== "/" && trigger !== "@") ||
    (start > 0 && !isWhitespace(text[start - 1] ?? ""))
  ) {
    return { kind: "none" };
  }
  const query = token.slice(1);
  return trigger === "/"
    ? { kind: "command", query, start, end }
    : { kind: "reference", query, start, end };
}

export function replaceComposerSuggestion(
  text: string,
  mode: Exclude<ComposerSuggestionMode, { readonly kind: "none" }>,
  replacement: string,
): string {
  return `${text.slice(0, mode.start)}${replacement}${text.slice(mode.end)}`;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
