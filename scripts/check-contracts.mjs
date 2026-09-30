#!/usr/bin/env node
// Cross-language contract drift check.
//
// JobEvent and EnhanceTaskPayload cross a process boundary as JSON: Python
// workers produce them, the TypeScript gateway consumes them. TS types are
// erased at runtime and the two definitions are hand-synced, so nothing else
// notices when they diverge. This compares the declarations directly.
//
// The casing asymmetry is deliberate and enforced, not tolerated:
// JobEvent is camelCase on the wire, EnhanceTaskPayload is snake_case.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TS_FILE = "shared/src/events.ts";
const DEFAULT_PY_FILE = "workers/common/contracts.py";

const CONTRACTS = [
  { name: "JobEvent", casing: "camel" },
  { name: "EnhanceTaskPayload", casing: "snake" },
  // Worker -> gateway capability adverts, which jobs are now routed by.
  { name: "StrategyAdvert", casing: "snake", ts: "gateway/src/queue/routing.ts" },
  // Ask the room: task kwargs are snake_case (Python reads them); the replies
  // and embeddings Python writes are single words, valid in either.
  { name: "EmbedItem", casing: "snake" },
  { name: "EmbedPassagesTask", casing: "snake" },
  { name: "EmbeddedVector", casing: "snake" },
  { name: "EmbeddingResult", casing: "snake" },
  { name: "AskHistoryTurn", casing: "snake" },
  { name: "AskPrepareTask", casing: "snake" },
  { name: "AskPassage", casing: "snake" },
  { name: "AskAnswerTask", casing: "snake" },
  { name: "AskReply", casing: "snake" },
];

// Names both sides must spell the same: a task name or a stream key that
// drifts fails silently - the message is sent, and nobody is listening.
const CONSTANTS = [
  "TASK_ENHANCE",
  "JOB_EVENT_STREAM",
  "TASK_EMBED_PASSAGES",
  "TASK_ASK_PREPARE",
  "TASK_ASK_ANSWER",
  "QUEUE_ASK",
  "QUEUE_EMBED",
  "EMBEDDING_STREAM",
  "ASK_CHANNEL_PREFIX",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
];

// A type is only comparable if both sides map onto the same canonical name.
// Anything unmapped is a hard failure rather than a skip — silently ignoring an
// unknown type is exactly how a drift check turns into a false pass.
const TS_TYPES = new Map([
  ["string", "string"],
  ["number", "number"],
  ["boolean", "boolean"],
  ["Record<string, unknown>", "map"],
  ["MediaType", "MediaType"],
  ["JobStatus", "JobStatus"],
  ["JobEventArtifact[]", "artifact-list"],
  ["EmbedItem[]", "embed-item-list"],
  ["EmbeddedVector[]", "embedded-vector-list"],
  ["AskPassage[]", "ask-passage-list"],
  ["AskHistoryTurn[]", "ask-history-list"],
  ["AskReplyType", "AskReplyType"],
]);

const PY_TYPES = new Map([
  ["str", "string"],
  ["int", "number"],
  ["float", "number"],
  ["bool", "boolean"],
  ["dict[str, Any]", "map"],
  ["MediaType", "MediaType"],
  ["JobStatus", "JobStatus"],
  ["list[JobEventArtifact]", "artifact-list"],
  ["list[EmbedItem]", "embed-item-list"],
  ["list[EmbeddedVector]", "embedded-vector-list"],
  ["list[AskPassage]", "ask-passage-list"],
  ["list[AskHistoryTurn]", "ask-history-list"],
  ["AskReplyType", "AskReplyType"],
]);

const CASING = {
  camel: { test: (n) => /^[a-z][a-zA-Z0-9]*$/.test(n) && !n.includes("_"), label: "camelCase" },
  snake: { test: (n) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n), label: "snake_case" },
};

function read(rel) {
  try {
    return readFileSync(path.join(repoRoot, rel), "utf8");
  } catch (err) {
    fail(`cannot read ${rel}: ${err.message}`);
  }
}

function fail(message) {
  console.error(`contract check: ${message}`);
  process.exit(2);
}

function stripTsComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function parseTsInterface(src, name) {
  const header = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(src);
  if (!header) return null;

  let depth = 1;
  let i = header.index + header[0].length;
  for (; i < src.length && depth > 0; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") depth -= 1;
  }
  if (depth !== 0) return null;

  const fields = new Map();
  for (const chunk of stripTsComments(src.slice(header.index + header[0].length, i - 1)).split(";")) {
    const line = chunk.trim();
    if (!line) continue;
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(line);
    if (!m) return { error: `unparsed member in TS ${name}: ${JSON.stringify(line)}` };
    const [, field, optionalMark, rawType] = m;
    const parts = rawType.split("|").map((p) => p.replace(/\s+/g, " ").trim());
    const nonNull = parts.filter((p) => p !== "undefined" && p !== "null");
    fields.set(field, {
      type: nonNull.join(" | "),
      optional: Boolean(optionalMark) || nonNull.length !== parts.length,
    });
  }
  return { fields };
}

function parsePyDataclass(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^class\\s+${name}\\s*[(:]`).test(l));
  if (start === -1) return null;

  const fields = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) break; // dedent: class body is over
    const body = line.trim();
    // Methods end the field block; decorators and docstrings are not fields.
    if (/^(def|async def|@|"""|#)/.test(body)) break;

    const m = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*(?:=\s*(.+))?$/.exec(body);
    if (!m) return { error: `unparsed member in Python ${name}: ${JSON.stringify(body)}` };
    const [, field, rawType] = m;
    const parts = rawType.split("|").map((p) => p.replace(/\s+/g, " ").trim());
    const nonNull = parts.filter((p) => p !== "None");
    fields.set(field, {
      type: nonNull.join(" | "),
      optional: nonNull.length !== parts.length,
    });
  }
  return { fields };
}

function canonical(map, type, lang) {
  const hit = map.get(type);
  if (hit) return { ok: true, value: hit };
  return {
    ok: false,
    value: `unmapped ${lang} type ${JSON.stringify(type)} — add it to ${lang === "TS" ? "TS_TYPES" : "PY_TYPES"} in scripts/check-contracts.mjs`,
  };
}

function compare(contract, ts, py) {
  const problems = [];
  const { name, casing } = contract;
  const TS_FILE = contract.ts ?? DEFAULT_TS_FILE;
  const PY_FILE = contract.py ?? DEFAULT_PY_FILE;
  const convention = CASING[casing];

  for (const [side, parsed, file] of [
    ["TypeScript", ts, TS_FILE],
    ["Python", py, PY_FILE],
  ]) {
    for (const field of parsed.fields.keys()) {
      if (!convention.test(field)) {
        problems.push(`${side} ${file}: field "${field}" is not ${convention.label} (${name} is ${convention.label} on the wire)`);
      }
    }
  }

  for (const field of ts.fields.keys()) {
    if (!py.fields.has(field)) problems.push(`missing in Python (${PY_FILE}): ${field}`);
  }
  for (const field of py.fields.keys()) {
    if (!ts.fields.has(field)) problems.push(`missing in TypeScript (${TS_FILE}): ${field}`);
  }

  for (const [field, tsField] of ts.fields) {
    const pyField = py.fields.get(field);
    if (!pyField) continue;

    const tsCanon = canonical(TS_TYPES, tsField.type, "TS");
    const pyCanon = canonical(PY_TYPES, pyField.type, "PY");
    if (!tsCanon.ok) problems.push(`${field}: ${tsCanon.value}`);
    if (!pyCanon.ok) problems.push(`${field}: ${pyCanon.value}`);
    if (tsCanon.ok && pyCanon.ok && tsCanon.value !== pyCanon.value) {
      problems.push(`type mismatch on ${field}: TS ${tsField.type} vs Python ${pyField.type}`);
    }

    if (tsField.optional !== pyField.optional) {
      const opt = (v) => (v ? "optional" : "required");
      problems.push(`optionality mismatch on ${field}: TS ${opt(tsField.optional)} vs Python ${opt(pyField.optional)}`);
    }
  }

  return problems;
}

let failures = 0;
for (const contract of CONTRACTS) {
  const TS_FILE = contract.ts ?? DEFAULT_TS_FILE;
  const PY_FILE = contract.py ?? DEFAULT_PY_FILE;
  const ts = parseTsInterface(read(TS_FILE), contract.name);
  const py = parsePyDataclass(read(PY_FILE), contract.name);

  if (!ts) fail(`interface ${contract.name} not found in ${TS_FILE}`);
  if (!py) fail(`dataclass ${contract.name} not found in ${PY_FILE}`);
  if (ts.error) fail(ts.error);
  if (py.error) fail(py.error);
  if (ts.fields.size === 0) fail(`interface ${contract.name} in ${TS_FILE} parsed to zero fields`);
  if (py.fields.size === 0) fail(`dataclass ${contract.name} in ${PY_FILE} parsed to zero fields`);

  const problems = compare(contract, ts, py);
  if (problems.length === 0) {
    console.log(`ok  ${contract.name} — ${ts.fields.size} fields aligned (${CASING[contract.casing].label})`);
    continue;
  }

  failures += problems.length;
  console.error(`DRIFT  ${contract.name}`);
  for (const problem of problems) console.error(`  - ${problem}`);
}

// Constants: `export const X = "..."` / `X = "..."`, or a number.
const tsSource = read(DEFAULT_TS_FILE);
const pySource = read(DEFAULT_PY_FILE);
for (const name of CONSTANTS) {
  const ts = new RegExp(`export const ${name}\\s*=\\s*("[^"]*"|\\d+)\\s*;`).exec(tsSource)?.[1];
  const py = new RegExp(`^${name}\\s*=\\s*("[^"]*"|\\d+)\\s*$`, "m").exec(pySource)?.[1];
  if (ts === undefined || py === undefined) {
    failures += 1;
    console.error(`DRIFT  ${name}: missing in ${ts === undefined ? DEFAULT_TS_FILE : DEFAULT_PY_FILE}`);
  } else if (ts !== py) {
    failures += 1;
    console.error(`DRIFT  ${name}: TS ${ts} vs Python ${py}`);
  }
}
if (failures === 0) console.log(`ok  ${CONSTANTS.length} shared constants spelled the same`);

if (failures > 0) {
  console.error(`\n${failures} contract problem(s). ${DEFAULT_TS_FILE} and ${DEFAULT_PY_FILE} (and any contract's own files) must be changed together.`);
  process.exit(1);
}
