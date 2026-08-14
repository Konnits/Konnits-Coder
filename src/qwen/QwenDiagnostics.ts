import { redactSensitive } from "../logging/redaction.js";

const MAX_CAPTURED_CHARACTERS = 32_768;

export class QwenDiagnosticCapture {
  private captured = "";

  constructor(private readonly knownSecrets: readonly string[] = []) {}

  add(message: string): string | undefined {
    if (/Writing to stdin/iu.test(message)) {
      return undefined;
    }

    const safeMessage = redactSensitive(message.trim(), this.knownSecrets);
    if (safeMessage.length === 0) {
      return undefined;
    }
    this.captured = `${this.captured}\n${safeMessage}`.slice(
      -MAX_CAPTURED_CHARACTERS,
    );
    return safeMessage;
  }

  clear(): void {
    this.captured = "";
  }

  containsMissingSession(): boolean {
    return /No saved session found with ID/iu.test(this.captured);
  }

  summary(): string | undefined {
    const relevant = this.captured
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          /error|failed|missing|not found|no saved session|unauthori[sz]ed|forbidden|ECONN|fetch/iu.test(
            line,
          ),
      );
    const unique = [...new Set(relevant)];
    return unique.length === 0 ? undefined : unique.slice(-8).join("\n");
  }
}

export function actionableQwenError(
  message: string,
  diagnostic?: string,
): string {
  const combined = `${message}\n${diagnostic ?? ""}`;
  if (
    /ENOENT|executable (?:file )?(?:is )?(?:unavailable|not found)|Bundled qwen CLI not found|spawn .*ENOENT/iu.test(
      combined,
    )
  ) {
    return "Qwen Code could not start. Check qwenFrontend.qwen.executablePath or reinstall Qwen Code. See the Qwen Frontend Output for diagnostic details.";
  }
  if (
    /401|403|unauthori[sz]ed|invalid[_ ]api[_ ]key|missing api key/iu.test(
      combined,
    )
  ) {
    return "Unable to authenticate with the configured model provider. Check the Qwen credential and LM Studio authentication. See the Qwen Frontend Output for diagnostic details.";
  }
  if (/ECONNREFUSED|fetch failed|connect/iu.test(combined)) {
    return "Qwen Code could not reach its configured model provider. Check the base URL and provider availability. See the Qwen Frontend Output for diagnostic details.";
  }
  if (/CLI process exited|CLI process terminated/iu.test(message)) {
    return "Qwen Code exited before starting or completing the session. See the Qwen Frontend Output for diagnostic details.";
  }
  return message;
}
