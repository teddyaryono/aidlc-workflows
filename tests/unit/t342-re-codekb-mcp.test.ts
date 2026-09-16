// covers: file:aidlc-common/stages/inception/reverse-engineering.md, file:knowledge/aidlc-developer-agent/re-artifacts.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-architect-agent.md

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// t342 — Reverse Engineering's CodeKB-MCP-first evidence source. RE resolves ONE
// structural evidence source per repo before it inspects anything: the optional
// external CodeKB MCP server when its readiness gate passes, otherwise the
// ordinary filesystem scan. CodeKB REPLACES the scan on that path (it does not
// supplement it), the fallback stays the default so an absent, unconfigured, or
// ungranted server never blocks the stage, and the store-safety contract (Step 1
// guard + snapshot, both pipeline receipts, the compare-and-swap publish, the
// approval gate) is identical on both paths.
//
// Mechanism: none — a structural check over the SHIPPED bytes (the same
// dist/claude/.claude tree t05/t87/t154 read), so the projection the harnesses
// consume is covered directly. Zero tokens, no process boundary.
//
// Prose assertions run against a whitespace-FLATTENED copy so a reflow of the
// authored markdown is not a test failure; only the contract wording is pinned.

const stageBody = (phase: string, slug: string): string =>
  readFileSync(join(AIDLC_SRC, "aidlc-common", "stages", phase, `${slug}.md`), "utf8");
const knowledge = (agent: string, file: string): string =>
  readFileSync(join(AIDLC_SRC, "knowledge", agent, file), "utf8");
const persona = (name: string): string =>
  readFileSync(join(AIDLC_SRC, "agents", `${name}.md`), "utf8");

/** Collapse every whitespace run to a single space (reflow-tolerant matching). */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const RE = stageBody("inception", "reverse-engineering");
const RE_FLAT = flat(RE);
const RE_ARTIFACTS_FLAT = flat(knowledge("aidlc-developer-agent", "re-artifacts.md"));

/** The flattened slice of the stage between two authored markers. */
function section(startMarker: string, endMarker: string): string {
  const from = RE.indexOf(startMarker);
  const to = RE.indexOf(endMarker, from + startMarker.length);
  expect(from, `missing marker: ${startMarker}`).toBeGreaterThan(-1);
  expect(to, `missing marker after ${startMarker}: ${endMarker}`).toBeGreaterThan(from);
  return flat(RE.slice(from, to));
}

describe("t342 reverse-engineering CodeKB MCP evidence source", () => {
  // ── 1: exactly one source per repo, CodeKB first, never blended ───────────
  test("Step 2 resolves one evidence source per repo, CodeKB first, filesystem fallback", () => {
    expect(RE).toContain("#### Evidence source: CodeKB MCP first, filesystem scan fallback");
    expect(RE_FLAT).toContain("EXACTLY ONE source");
    expect(RE_FLAT).toContain("Never blend the two");
    expect(RE_FLAT).toContain("Resolve the gate per repo");
    // The CodeKB path REPLACES the scan — the whole point of the integration.
    expect(RE_FLAT).toContain("CodeKB IS the scan");
    expect(RE_FLAT).toContain("the ordinary discovery steps are replaced, not supplemented");
    // The evidence-source decision precedes the scan question list, and both sit
    // inside Step 2.
    const step2 = RE.indexOf("### Step 2:");
    const sourceBlock = RE.indexOf("#### Evidence source:");
    const questionList = RE.indexOf("from that repo's chosen evidence source");
    expect(sourceBlock).toBeGreaterThan(step2);
    expect(questionList).toBeGreaterThan(sourceBlock);
    expect(questionList).toBeLessThan(RE.indexOf("### Step 3:"));
  });

  test("the filesystem scan remains the default fallback, needing no external service", () => {
    expect(RE_FLAT).toContain("**Priority 1 — CodeKB MCP");
    expect(RE_FLAT).toContain("**Priority 2 — Filesystem scan (fallback, and the default path).**");
    expect(RE_FLAT).toContain("the only one that needs no external service");
    expect(RE_FLAT).toContain(
      "do not re-attempt CodeKB after falling back inside the same attempt",
    );
  });

  // ── 2: the readiness gate fails closed ───────────────────────────────────
  test("the readiness gate covers exposure, indexed coverage, and index freshness", () => {
    const gate = section("##### CodeKB readiness gate", "##### CodeKB query plan");
    expect(gate).toContain("all three checks, else fall back immediately");
    expect(gate).toContain("**Tools exposed.**");
    expect(gate).toContain("fall back without probing");
    expect(gate).toContain("narrowed `tools:` allowlist");
    expect(gate).toContain("**Indexed and covering.**");
    expect(gate).toContain("NON-ZERO indexed component count");
    expect(gate).toContain("**Index current for this repo.**");
    // A stale index is invisible to codekb-publish, so freshness must gate.
    expect(gate).toContain("cannot detect a stale index");
  });

  // ── 3: bounded queries, and gap-fill reads are the ONLY filesystem access ─
  test("the query plan is bounded and names the tools each artifact draws on", () => {
    const plan = section("##### CodeKB query plan", "##### Recording CodeKB-derived coverage");
    for (const tool of [
      "get_space_details",
      "get_stats",
      "get_component_from_description",
      "show_dependencies",
      "trace_flow",
    ]) {
      expect(plan, `query plan omits ${tool}`).toContain(tool);
    }
    expect(plan).toContain("at most 20 calls for a full rescan, 10 for a focused scan");
    expect(plan).toContain(
      "Gap-fill reads — the only filesystem access allowed on the CodeKB path",
    );
    expect(plan).toContain("never licence to resume exploring the codebase");
  });

  // ── 4: CodeKB coverage still speaks paths, still bounded by the snapshot ──
  test("CodeKB-derived coverage is recorded as snapshot-bounded repo-relative paths", () => {
    const recording = section(
      "##### Recording CodeKB-derived coverage",
      "For each repo selected for scanning, the developer resolves",
    );
    expect(recording).toContain("Deep coverage MUST stay inside the snapshot `paths`");
    expect(recording).toContain("`codekb-scope-diff` all speak paths, not component ids");
    expect(recording).toContain("never `Analyzed deeply`");
  });

  // ── 5: provenance is declared, verified, carried, and disclosed ───────────
  test("the handoff declares its source and the conductor verifies it before link 1", () => {
    expect(RE_FLAT).toContain("`### Evidence Source`");
    expect(RE_FLAT).toContain("name that repo's source as `codekb` or `filesystem`");
    expect(RE_FLAT).toContain("is a blended scan — reject it and redispatch");
    // Verification precedes the link-1 receipt.
    expect(RE.indexOf("`### Evidence Source`")).toBeLessThan(
      RE.indexOf("link --stage reverse-engineering --link aidlc-developer-agent"),
    );
    expect(RE_ARTIFACTS_FLAT).toContain("### Evidence Source");
    expect(RE_ARTIFACTS_FLAT).toContain("- **Source**: [codekb | filesystem]");
    expect(RE_ARTIFACTS_FLAT).toContain("- **Fallback reason**:");
  });

  test("provenance reaches the timestamp artifact and the completion summary", () => {
    expect(RE_FLAT).toContain("**Evidence source**: codekb | filesystem");
    expect(RE_FLAT).toContain("- **Evidence source per scanned repo**");
    expect(RE_FLAT).toContain("say which gate check failed");
    expect(RE_ARTIFACTS_FLAT).toContain("into `reverse-engineering-timestamp.md`");
  });

  // ── 6: the architect link inherits the source; nothing else in the stage moves
  test("the architect stays on the handoff's source and never opens source on the CodeKB path", () => {
    const step3 = section("### Step 3:", "### Step 4:");
    expect(step3).toContain("inherits the repo's evidence source");
    expect(step3).toContain("does NOT open application source");
    expect(step3).toContain("at most 5 targeted CodeKB calls");
  });

  test("the store-safety contract is unchanged on both paths", () => {
    expect(RE_FLAT).toContain("How the codebase is *discovered* is source-selected per repo");
    expect(RE_FLAT).toContain("hold on either path");
    // The deterministic surfaces the integration must not disturb.
    expect(RE_FLAT).toContain("engine workspace codekb-scope-diff --repo <repo>");
    expect(RE_FLAT).toContain("codekb-snapshot --repo <repo>");
    expect(RE_FLAT).toContain("codekb-publish");
    expect(RE_FLAT).toContain("link --stage reverse-engineering --link aidlc-architect-agent");
  });

  // ── 7: the two personas carry the same rule ───────────────────────────────
  test("developer and architect personas state the CodeKB-first rule", () => {
    const developer = flat(persona("aidlc-developer-agent"));
    expect(developer).toContain("Resolve the structural evidence source first");
    expect(developer).toContain("CodeKB replaces the code scan");
    expect(developer).toContain("One source per repo, never blended");
    expect(flat(persona("aidlc-architect-agent"))).toContain(
      "Stay on the evidence source the handoff declares",
    );
  });
});
