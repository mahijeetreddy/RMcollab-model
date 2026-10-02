// `npm run test:browsers`: the cross-browser specs in Firefox and WebKit (see
// playwright.config.ts). Sets CROSS_BROWSER in-process, so it works the same
// in PowerShell, cmd and bash without a dependency to do it.
import { spawnSync } from "node:child_process";

const run = spawnSync("npx", ["playwright", "test", "--project=firefox", "--project=webkit", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, CROSS_BROWSER: "1" },
});
process.exit(run.status ?? 1);
