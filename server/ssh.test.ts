import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact";
import { assertSafeSshHost, readCapped, shellQuote, sshCommandArgs, withRemoteDeadline } from "./ssh";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readCapped", () => {
  test("returns everything when under the cap", async () => {
    expect(await readCapped(streamOf("abc", "def"), 100)).toEqual({ text: "abcdef", truncated: false });
  });

  test("keeps exactly the cap and signals overflow once", async () => {
    let overflows = 0;
    const result = await readCapped(streamOf("aaaa", "bbbb", "cccc", "dddd"), 6, () => overflows++);
    expect(result).toEqual({ text: "aaaabb", truncated: true });
    expect(overflows).toBe(1);
  });

  test("output exactly at the cap is not flagged", async () => {
    expect(await readCapped(streamOf("abcd"), 4)).toEqual({ text: "abcd", truncated: false });
  });
});

describe("ssh host validation", () => {
  test("accepts config aliases, hostnames and user@host", () => {
    for (const host of ["spark-1", "node-b", "10.0.0.5", "node.lan", "ops@spark_2"]) {
      expect(assertSafeSshHost(host)).toBe(host);
    }
  });

  test("rejects values ssh would treat as options or shell syntax", () => {
    for (const host of ["-oProxyCommand=touch /tmp/pwned", "", "host; rm -rf ~", "a b", "$(id)"]) {
      expect(() => assertSafeSshHost(host)).toThrow();
    }
  });

  test("the host is always passed after the option terminator", () => {
    const args = sshCommandArgs("spark-1", "uptime");
    expect(args.slice(-3)).toEqual(["--", "spark-1", "uptime"]);
    expect(args.join(" ")).not.toContain("StrictHostKeyChecking");
  });
});

describe("remote deadline wrapper", () => {
  test("quoted text reaches the shell as one unchanged word", () => {
    const samples = ["plain", "it's", "a 'b' c", "'''", "", "two\nlines", '"$(id)" `id` $HOME; rm -rf /'];
    for (const text of samples) {
      const printed = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(text)}`]).stdout.toString();
      expect(printed).toBe(text);
    }
  });

  test("the wrapped command still runs as written, under a whole-second limit", () => {
    const wrapped = withRemoteDeadline(`echo "it's $((1 + 1))"`, 1500);
    const prefix = "timeout --kill-after=2 2 ";
    expect(wrapped.startsWith(prefix)).toBe(true);
    // macOS has no `timeout`, so run the part after it: the bash invocation itself.
    const printed = Bun.spawnSync(["sh", "-c", wrapped.slice(prefix.length)]).stdout.toString();
    expect(printed).toBe("it's 2\n");
  });
});

describe("redactSecrets", () => {
  test("masks flag values in both `--flag value` and `--flag=value` forms", () => {
    expect(redactSecrets("vllm serve --api-key sk-abc123 --port 8000")).toBe(
      "vllm serve --api-key [redacted] --port 8000"
    );
    expect(redactSecrets("run --hf-token=hf_xyz --model m")).toBe("run --hf-token=[redacted] --model m");
  });

  test("masks environment-style assignments and bearer tokens", () => {
    expect(redactSecrets("env HF_TOKEN=hf_xyz OPENAI_API_KEY=sk-1 python app.py")).toBe(
      "env HF_TOKEN=[redacted] OPENAI_API_KEY=[redacted] python app.py"
    );
    expect(redactSecrets("proxy --header Authorization: Bearer abc.def")).toBe(
      "proxy --header Authorization: Bearer [redacted]"
    );
  });

  test("leaves ordinary command lines untouched", () => {
    const plain = "python3 -u /run-data/smoke.py --max-tokens 512 --tokenizer-mode auto --port 8000";
    expect(redactSecrets(plain)).toBe(plain);
  });
});
