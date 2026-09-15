// Audit-record shape for sub-agent scopes, and previews that record nothing:
// a named sub-agent is on its attenuation record, a preview reports what a scope
// would be granted without writing to the trail or being usable as a scope, and
// a decision record names its kind. Plain Node asserts, the real engine core.
import { createRequire } from "node:module";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const require = createRequire(import.meta.url);
const { Watchlight, AttenuationDenied, DelegationDepthExceeded, ScopePreview } = require("../dist/index.js");

let pass = 0,
  fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${detail}`); fail++; }
};
const gov = () => {
  const auditDir = fs.mkdtempSync(join(os.tmpdir(), "wl-preview-"));
  const g = new Watchlight({ agent: "test-agent", auditDir });
  const recs = () => {
    const f = join(auditDir, "audit.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { g, recs };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ── a named sub-agent is on its attenuation record ──
  {
    const { g, recs } = gov();
    const root = await g.scope({ tools: ["read", "write"], intents: ["research"] });
    root.attenuate({ tools: ["read"], agent: "document-reader" });
    const named = recs().at(-1);
    ok("a named attenuation names the sub-agent", named.resource === "scope for document-reader");
    ok("...and carries the chain it acts under", same(named.actor_chain, ["test-agent", "document-reader"]));
    root.attenuate({ tools: ["read"] });
    const unnamed = recs().at(-1);
    ok("an unnamed attenuation keeps its shape",
      unnamed.resource === "sub-agent depth 1" && unnamed.actor_chain === undefined);

    g.delegate(root, "summarizer", { tools: ["read"] });
    const del = recs().at(-1);
    ok("delegate() records the sub-agent it names",
      del.resource === "scope for summarizer" && same(del.actor_chain, ["test-agent", "summarizer"]));

    let refused;
    try { root.attenuate({ tools: ["delete"], agent: "rogue" }); } catch (e) { refused = e; }
    const deny = recs().at(-1);
    ok("a refused named attenuation names the sub-agent",
      refused instanceof AttenuationDenied && deny.decision === "Deny" && deny.resource === "scope for rogue" &&
        same(deny.actor_chain, ["test-agent", "rogue"]));

    const shallow = await g.scope({ tools: ["read"], maxDepth: 0 });
    let tooDeep;
    try { shallow.attenuate({ tools: ["read"], agent: "deep-reader" }); } catch (e) { tooDeep = e; }
    const depth = recs().at(-1);
    ok("a named hop past the depth limit names the sub-agent",
      tooDeep instanceof DelegationDepthExceeded && depth.reason_code === "DELEGATION_DEPTH_EXCEEDED" &&
        depth.resource === "scope for deep-reader" && same(depth.actor_chain, ["test-agent", "deep-reader"]));
  }

  // ── previews: what a scope would grant, with nothing recorded ──
  {
    const { g, recs } = gov();
    const preview = await g.previewScope({ tools: ["read", "write"], intents: ["research"] });
    const reader = preview.previewAttenuate({ tools: ["read"], agent: "document-reader" });
    const refused = preview.previewAttenuate({ tools: ["delete"] });
    ok("previews record nothing", recs().length === 0);
    ok("a preview is a ScopePreview", preview instanceof ScopePreview);
    ok("a preview reports the clamped grant",
      reader.allowed && same(reader.allowedTools, ["read"]) && reader.depth === 1 &&
        same(reader.actorChain, ["test-agent", "document-reader"]));
    ok("a refused preview says why",
      !refused.allowed && refused.violations.length > 0 && refused.reason.length > 0 && same(refused.allowedTools, ["delete"]));

    const root = await g.scope({ tools: ["read", "write"], intents: ["research", "analysis"] });
    const written = recs().length;
    const p = root.previewAttenuate({ tools: ["read"], intents: ["research"] });
    ok("a preview from a live scope records nothing", recs().length === written);
    const child = root.attenuate({ tools: ["read"], intents: ["research"] });
    ok("a preview matches what attenuate grants",
      p.allowed && same(p.allowedTools, child.allowedTools) && same(p.allowedIntents, child.allowedIntents) &&
        p.depth === child.depth);
    ok("toJSON carries the grant", same(JSON.parse(JSON.stringify(p)).tools, child.allowedTools));

    const low = (await g.previewScope({ tools: ["read"], maxDepth: 0 })).previewAttenuate({ tools: ["read"] });
    ok("a preview past the depth limit says so", !low.allowed && low.reasonCode === "DELEGATION_DEPTH_EXCEEDED");
    ok("nothing is granted below a refused preview", !low.previewAttenuate({ tools: ["read"] }).allowed);

    ok("a preview is not a scope",
      typeof preview.attenuate === "undefined" && typeof preview.toToken === "undefined");
    let delegateErr;
    try { g.delegate(preview, "document-reader"); } catch (e) { delegateErr = e; }
    ok("delegate() refuses a preview", delegateErr instanceof TypeError, String(delegateErr));
  }

  // ── a decision record names its kind ──
  {
    const { g, recs } = gov();
    g.allow('permit(principal, action == Action::"read", resource);', "allow-read");
    await g.authorize({ action: "read", resource: "doc.txt" });
    const d = recs().at(-1);
    ok("a decision record's event is \"decision\"", d.event === "decision" && d.decision === "Allow");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
