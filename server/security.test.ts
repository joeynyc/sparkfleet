import { describe, expect, test } from "bun:test";
import { checkAccess, createAccessPolicy, tokenMatches } from "./security";

const policy = createAccessPolicy(7700, "a".repeat(32));
const cookie = `${policy.cookieName}=${policy.token}`;

function request(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:7700/api/exec", { method: "POST", headers });
}

describe("checkAccess", () => {
  test("allows a same-origin request carrying the session cookie", () => {
    const req = request({ host: "127.0.0.1:7700", origin: "http://127.0.0.1:7700", cookie });
    expect(checkAccess(req, policy)).toBeNull();
  });

  test("allows a non-browser client that has the token but sends no Origin", () => {
    expect(checkAccess(request({ host: "localhost:7700", cookie }), policy)).toBeNull();
  });

  test("refuses another site's request even when the cookie is attached", () => {
    const req = request({ host: "127.0.0.1:7700", origin: "https://evil.example", cookie });
    expect(checkAccess(req, policy)).toBe("origin");
  });

  test("refuses an opaque origin (sandboxed frame, file://)", () => {
    const req = request({ host: "127.0.0.1:7700", origin: "null", cookie });
    expect(checkAccess(req, policy)).toBe("origin");
  });

  test("refuses a rebound hostname pointing at loopback", () => {
    const req = request({ host: "evil.example:7700", origin: "http://evil.example:7700", cookie });
    expect(checkAccess(req, policy)).toBe("host");
  });

  test("refuses the right host on the wrong port", () => {
    expect(checkAccess(request({ host: "127.0.0.1:9999", cookie }), policy)).toBe("host");
  });

  test("refuses a request without the cookie", () => {
    const req = request({ host: "127.0.0.1:7700", origin: "http://127.0.0.1:7700" });
    expect(checkAccess(req, policy)).toBe("auth");
  });

  test("refuses a wrong token and a token under another cookie name", () => {
    const wrong = request({ host: "127.0.0.1:7700", cookie: `${policy.cookieName}=${"b".repeat(32)}` });
    const misnamed = request({ host: "127.0.0.1:7700", cookie: `other=${policy.token}` });
    expect(checkAccess(wrong, policy)).toBe("auth");
    expect(checkAccess(misnamed, policy)).toBe("auth");
  });

  test("finds the session cookie among unrelated cookies", () => {
    const req = request({ host: "127.0.0.1:7700", cookie: `theme=dark; ${cookie}; other=1` });
    expect(checkAccess(req, policy)).toBeNull();
  });
});

describe("tokens", () => {
  test("a prefix of the token does not match", () => {
    expect(tokenMatches(policy.token.slice(0, -1), policy)).toBe(false);
    expect(tokenMatches("", policy)).toBe(false);
    expect(tokenMatches(null, policy)).toBe(false);
  });

  test("generated tokens differ per launch", () => {
    expect(createAccessPolicy(7700).token).not.toBe(createAccessPolicy(7700).token);
  });

  test("a weak pinned token is rejected at startup", () => {
    expect(() => createAccessPolicy(7700, "hunter2")).toThrow();
  });
});
