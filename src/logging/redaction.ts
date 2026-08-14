export function redactSensitive(
  message: string,
  knownSecrets: readonly string[] = [],
): string {
  let redacted = message;
  const secrets = [...new Set(knownSecrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted
    .replace(/Bearer\s+[^\s,"'}]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    )
    .replace(/:\/\/[^/@\s]+@/gu, "://[REDACTED]@");
}
