import { describe, it, expect, vi } from "vitest";
import { isValidEmail, subscribeToButtondown } from "./waitlist";

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("matt.granmoe+x@bunsen.dev")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("no@domain")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("subscribeToButtondown", () => {
  it("posts to Buttondown with the right URL, auth, and payload", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));
    const result = await subscribeToButtondown("user@example.com", "test-key", fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.buttondown.com/v1/subscribers");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token test-key");
    // We rely on Buttondown's own spam firewall — never bypass it.
    expect((init.headers as Record<string, string>)["X-Buttondown-Bypass-Firewall"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      email_address: "user@example.com",
      tags: ["landing-page"],
    });
  });

  it("rejects an invalid email before calling the network", async () => {
    const fetchMock = vi.fn();
    const result = await subscribeToButtondown("bogus", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a config error when no API key is set", async () => {
    const result = await subscribeToButtondown("user@example.com", undefined, (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "config" });
  });

  it("treats an already-subscribed 400 (JSON code) as success (idempotent)", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "email_already_exists", detail: "x" }), { status: 400 }),
    );
    const result = await subscribeToButtondown("dupe@example.com", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
  });

  it("treats an already-subscribed 409 as success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "email_already_exists" }), { status: 409 }));
    const result = await subscribeToButtondown("dupe@example.com", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
  });

  it("does not swallow a non-duplicate 400 as success", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "invalid_email", detail: "bad address" }), { status: 400 }),
    );
    const result = await subscribeToButtondown("user@example.com", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "error" });
  });

  it("surfaces server errors", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const result = await subscribeToButtondown("user@example.com", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "error" });
  });

  it("surfaces network failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await subscribeToButtondown("user@example.com", "test-key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "error" });
  });
});
