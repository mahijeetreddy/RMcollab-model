import { describe, expect, it } from "vitest";
import { config, DEV_FILE_SIGNING_SECRET, productionProblems, type Config } from "../src/config.js";

const production = (overrides: Partial<{ secret: string; origins: string[]; privateUrls: boolean; base: string }> = {}) =>
  ({
    ...config,
    production: true,
    publicBaseUrl: overrides.base ?? "https://rmcollab.example",
    allowedOrigins: overrides.origins ?? ["https://rmcollab.example"],
    files: { ...config.files, signingSecret: overrides.secret ?? "a".repeat(64) },
    webhooks: { ...config.webhooks, allowPrivateUrls: overrides.privateUrls ?? false },
  }) as Config;

describe("productionProblems", () => {
  it("has nothing to say in development", () => {
    expect(productionProblems({ ...config, production: false } as Config)).toEqual([]);
  });

  it("accepts a properly configured production", () => {
    expect(productionProblems(production())).toEqual([]);
  });

  it("refuses the defaults that are holes on the internet", () => {
    const problems = productionProblems(
      production({ secret: DEV_FILE_SIGNING_SECRET, origins: ["*"], privateUrls: true, base: "http://localhost:4000" }),
    );
    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).toMatch(/FILE_SIGNING_SECRET.*ALLOWED_ORIGINS.*WEBHOOK_ALLOW_PRIVATE_URLS.*PUBLIC_BASE_URL/);
  });

  it("refuses a signing secret too short to be random", () => {
    expect(productionProblems(production({ secret: "hunter2" }))).toHaveLength(1);
  });
});
