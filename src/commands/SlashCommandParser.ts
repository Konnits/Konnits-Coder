import type { ParsedSlashCommand } from "./SlashCommand.js";

const COMMAND_NAME = /^[\p{L}\p{N}_.:?-]+$/u;

export function parseSlashCommand(
  input: string,
): ParsedSlashCommand | undefined {
  const raw = input.trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return undefined;
  }

  const firstWhitespace = raw.search(/\s/u);
  const commandToken = raw.slice(
    1,
    firstWhitespace === -1 ? undefined : firstWhitespace,
  );
  if (commandToken.length === 0 || !COMMAND_NAME.test(commandToken)) {
    return undefined;
  }

  const argumentText =
    firstWhitespace === -1 ? "" : raw.slice(firstWhitespace).trim();
  return {
    command: `/${commandToken.toLowerCase()}`,
    args: tokenizeArguments(argumentText),
    raw,
  };
}

function tokenizeArguments(value: string): readonly string[] {
  const result: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  const finish = (): void => {
    if (current.length > 0) {
      result.push(current);
      current = "";
    }
  };

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      finish();
      continue;
    }
    current += character;
  }
  if (escaped) {
    current += "\\";
  }
  finish();
  return result;
}
