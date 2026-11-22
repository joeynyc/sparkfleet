/** Largest stdout or stderr kept from one remote command. */
export const MAX_EXEC_OUTPUT_BYTES = 256 * 1024;

// Host keys are verified against the user's known_hosts; BatchMode makes an
// unknown or changed key fail loudly instead of prompting or being accepted.
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
  // One authenticated connection per node, shared by telemetry and every command.
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=~/.ssh/sparkpit-%C",
  "-o",
  "ControlPersist=60",
];

const SAFE_SSH_HOST = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;

/** Rejects values ssh would parse as an option (e.g. `-oProxyCommand=...`). */
export function assertSafeSshHost(host: string): string {
  if (!SAFE_SSH_HOST.test(host)) {
    throw new Error(`Invalid SSH host "${host}": expected an ssh config alias or hostname`);
  }
  return host;
}

export function sshCommandArgs(host: string, remoteCommand: string): string[] {
  return ["ssh", ...SSH_OPTIONS, "--", assertSafeSshHost(host), remoteCommand];
}

export function sshTerminalArgs(host: string): string[] {
  return ["ssh", "-tt", "-o", "ServerAliveInterval=10", "--", assertSafeSshHost(host)];
}

export interface CappedText {
  text: string;
  truncated: boolean;
}

/**
 * Drains a stream but keeps at most `maxBytes`. `onOverflow` fires once when
 * the cap is hit so the caller can stop the producer.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow?: () => void
): Promise<CappedText> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (truncated) continue;
    const room = maxBytes - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      size = maxBytes;
      truncated = true;
      onOverflow?.();
    } else {
      chunks.push(value);
      size += value.byteLength;
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export interface SshRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Output exceeded MAX_EXEC_OUTPUT_BYTES and the command was stopped. */
  truncated: boolean;
  timedOut: boolean;
}

const REMOTE_KILL_GRACE_SEC = 2;
const LOCAL_BACKSTOP_MS = 5000;
// Exit statuses of coreutils `timeout`: 124 after SIGTERM, 137 when it had to SIGKILL.
const TIMEOUT_EXIT_CODES = [124, 137];

/** Quotes text as a single POSIX shell word. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wraps a command so the node stops it, and its children, at the deadline.
 * Killing only the local ssh client is not enough: a multiplexed client waits
 * for the remote command, and the command itself would keep running.
 */
export function withRemoteDeadline(command: string, timeoutMs: number): string {
  const seconds = Math.ceil(timeoutMs / 1000);
  return `timeout --kill-after=${REMOTE_KILL_GRACE_SEC} ${seconds} bash -c ${shellQuote(command)}`;
}

export async function runSsh(
  host: string,
  remoteCommand: string,
  timeoutMs: number
): Promise<SshRunResult> {
  const started = Date.now();
  const proc = Bun.spawn(sshCommandArgs(host, withRemoteDeadline(remoteCommand, timeoutMs)), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // SIGKILL, because a multiplexed ssh client answers SIGTERM by waiting for the remote side.
  const stop = () => proc.kill("SIGKILL");
  // Only reached if the connection hangs; normally the node enforces the deadline.
  let backstopFired = false;
  const backstop = setTimeout(() => {
    backstopFired = true;
    stop();
  }, timeoutMs + LOCAL_BACKSTOP_MS);

  const [out, err, exitCode] = await Promise.all([
    readCapped(proc.stdout, MAX_EXEC_OUTPUT_BYTES, stop),
    readCapped(proc.stderr, MAX_EXEC_OUTPUT_BYTES, stop),
    proc.exited,
  ]);
  clearTimeout(backstop);

  const durationMs = Date.now() - started;
  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    durationMs,
    truncated: out.truncated || err.truncated,
    timedOut: backstopFired || (TIMEOUT_EXIT_CODES.includes(exitCode) && durationMs >= timeoutMs),
  };
}
