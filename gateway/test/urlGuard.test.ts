import { describe, expect, it } from "vitest";
import { isPrivateAddress, validateWebhookUrl } from "../src/webhooks/urlGuard.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  // WHATWG URL rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so the hex form is what the guard actually sees.
  it.each(["::ffff:7f00:1", "::ffff:a9fe:a9fe"])(
    "treats hex-form IPv4-mapped %s as private",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  // Same bypass through the other two prefixes that carry an IPv4 in their low
  // 32 bits: NAT64 routes 64:ff9b::/96 to the embedded IPv4 on a NAT64 network.
  it.each(["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::127.0.0.1", "::7f00:1"])(
    "treats NAT64 / IPv4-compatible %s embedding a private IPv4 as private",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  // The decoder must not overcorrect: an embedded *public* IPv4 is still public.
  it.each(["::ffff:808:808", "::ffff:8.8.8.8", "64:ff9b::101:101"])(
    "treats %s embedding a public IPv4 as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("validateWebhookUrl with private URLs disallowed", () => {
  it.each([
    ["ftp://example.com/hook", /http or https/],
    ["https://user:pass@example.com/hook", /credentials/],
    ["not a url", /valid absolute URL/],
    ["/relative/path", /valid absolute URL/],
  ])("rejects %s", async (input, reason) => {
    const result = await validateWebhookUrl(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it.each([
    "http://127.0.0.1/x",
    "http://169.254.169.254/",
    "http://10.0.0.5:8080/hook",
    "http://[::1]/x",
    "http://2130706433/", // decimal-encoded 127.0.0.1
    "http://0x7f.1/",
  ])("rejects private target %s", async (input) => {
    expect(await validateWebhookUrl(input)).toEqual({
      ok: false,
      reason: "url resolves to a private or loopback address",
    });
  });

  it.each(["http://[::ffff:127.0.0.1]/x", "http://[::ffff:169.254.169.254]/"])(
    "rejects IPv4-mapped IPv6 literal %s",
    async (input) => {
      expect((await validateWebhookUrl(input)).ok).toBe(false);
    },
  );

  it("accepts a public IP literal without a DNS lookup", async () => {
    expect(await validateWebhookUrl("https://8.8.8.8/hook")).toEqual({ ok: true });
  });
});
