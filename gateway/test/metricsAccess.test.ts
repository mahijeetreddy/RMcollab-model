import { describe, expect, it } from "vitest";
import { config, type Config } from "../src/config.js";
import { metricsAllowed } from "../src/http/routes/metrics.js";

const prod = (metricsToken: string | null) => ({ ...config, production: true, metricsToken }) as Config;

describe("metricsAllowed", () => {
  it("is open in development", () => {
    expect(metricsAllowed(undefined, { ...config, production: false } as Config)).toBe(true);
  });

  it("is closed in production without a configured token", () => {
    expect(metricsAllowed("Bearer anything", prod(null))).toBe(false);
  });

  it("takes only the configured token in production", () => {
    expect(metricsAllowed("Bearer s3cret-token", prod("s3cret-token"))).toBe(true);
    expect(metricsAllowed("Bearer wrong", prod("s3cret-token"))).toBe(false);
    expect(metricsAllowed(undefined, prod("s3cret-token"))).toBe(false);
  });
});
