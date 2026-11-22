const REDACTED = "[redacted]";

// `token(?!s|iz)` keeps counts and tokenizer settings (`--max-tokens 512`) readable.
const SECRET_WORD = "(?:key|token(?!s|iz)|secret|passw(?:or)?d|credential)";

// `--api-key VALUE`, `--token=VALUE`, `-password VALUE`
const SECRET_FLAG = new RegExp(`(--?[\\w-]*${SECRET_WORD}[\\w-]*(?:=|\\s+))(\\S+)`, "gi");
// `HF_TOKEN=VALUE`, `api_key=VALUE`
const SECRET_ASSIGNMENT = new RegExp(`(\\b\\w*${SECRET_WORD}\\w*=)(\\S+)`, "gi");
const BEARER = /(\bBearer\s+)(\S+)/gi;

/**
 * Masks credential-looking values in a process command line before it is sent
 * to the browser. Errs towards over-redaction: a hidden path is harmless, a
 * leaked API key is not.
 */
export function redactSecrets(commandLine: string): string {
  return commandLine
    .replace(SECRET_FLAG, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`);
}
