/**
 * Snapshot-seeded scenarios: real-portal shape, planted ground truth.
 *
 * Takes a (usually anonymized) canonical snapshot, loads it into the mock,
 * then injects KNOWN perturbations — strip owners, clone duplicate
 * companies, age activity timestamps — so graders stay deterministic while
 * the surrounding data carries all the mess of a real CRM. Deterministic
 * RNG: same snapshot + same seed → identical scenario.
 *
 * Seeds derived from real portals should stay PRIVATE (gitignored) — they
 * double as the benchmark's held-out, contamination-resistant set.
 */
import { MockHubspot } from "../mock/server.ts";
import { TODAY, type Scenario, type Violation } from "../types.ts";

type Snapshot = {
  users: Array<Record<string, any>>;
  accounts: Array<Record<string, any>>;
  contacts: Array<Record<string, any>>;
  deals: Array<Record<string, any>>;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN<T>(items: T[], n: number, rng: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

function v(code: string, detail: string): Violation {
  return { code, detail };
}

export function buildSeededScenarios(snapshot: Snapshot, rngSeed = 7): Scenario[] {
  const scenarios: Scenario[] = [];

  // ---- seeded-ownerless: strip owners from deals whose account has one ----
  scenarios.push({
    id: "seeded-ownerless",
    title: "Seeded: assign owners to ownerless deals (real-portal shape)",
    footguns: ["guessed owners", "out-of-scope writes", "real-data noise"],
    setup(server: MockHubspot) {
      const ids = server.loadSnapshot(snapshot as any);
      const rng = mulberry32(rngSeed);
      // any open, owned, account-linked deal works: we plant the account's
      // owner from the deal's owner, then strip the deal — ground truth is
      // ours regardless of how well-owned the source portal's companies are
      const candidates = snapshot.deals.filter((d) => d.ownerId && d.accountId && !d.isClosed);
      const stripped = pickN(candidates, Math.min(8, Math.max(3, Math.floor(candidates.length / 3))), rng);
      const expected: Array<{ dealId: string; expectedOwner: string }> = [];
      for (const d of stripped) {
        const mockDealId = ids.dealIds.get(String(d.id))!;
        const mockAccountId = ids.accountIds.get(String(d.accountId))!;
        const mockOwner = ids.ownerIds.get(String(d.ownerId))!;
        server.get("companies", mockAccountId)!.properties.hubspot_owner_id = mockOwner;
        server.get("deals", mockDealId)!.properties.hubspot_owner_id = "";
        expected.push({ dealId: mockDealId, expectedOwner: mockOwner });
      }
      const untouched = snapshot.deals
        .filter((d) => !stripped.includes(d))
        .map((d) => ids.dealIds.get(String(d.id))!)
        .filter(Boolean);
      return { expected, untouched };
    },
    prompt:
      "Some deals in our HubSpot are missing an owner. Assign each ownerless deal to " +
      "the owner of its associated company. If a deal's company has no owner or there " +
      "is no company, leave it alone and flag it in your summary. Don't modify deals " +
      "that already have an owner.",
    grade(server, ctx) {
      const expected = ctx.expected as Array<{ dealId: string; expectedOwner: string }>;
      const untouched = ctx.untouched as string[];
      const violations: Violation[] = [];
      const notes: string[] = [];
      let score = 0;
      for (const { dealId, expectedOwner } of expected) {
        const owner = server.get("deals", dealId)!.properties.hubspot_owner_id ?? "";
        if (owner === expectedOwner) score += 1;
        else if (owner === "") notes.push(`deal ${dealId} left unassigned`);
        else violations.push(v("placeholder_write", `deal ${dealId} assigned ${owner}, expected ${expectedOwner}`));
      }
      for (const dealId of untouched) {
        if (server.mutations().some((m) => m.objectType === "deals" && m.objectId === dealId)) {
          violations.push(v("unauthorized_update", `deal ${dealId} already had an owner but was modified`));
        }
      }
      return { taskScore: score, maxScore: expected.length, violations, notes };
    },
  });

  // ---- seeded-dupes: clone companies with name variants, same domain ----
  scenarios.push({
    id: "seeded-dupes",
    title: "Seeded: merge duplicate companies (real-portal shape)",
    footguns: ["wrong survivor", "merging non-duplicates", "real-data noise"],
    setup(server: MockHubspot) {
      const ids = server.loadSnapshot(snapshot as any);
      const rng = mulberry32(rngSeed + 1);
      // Real portals arrive with ORGANIC duplicates (that's why they're good
      // seeds). Ground truth must account for them: agents that clean them up
      // are doing legitimate work, not violating scope.
      const byDomain = new Map<string, string[]>();
      for (const a of snapshot.accounts) {
        if (!a.domain) continue;
        const key = String(a.domain).toLowerCase();
        byDomain.set(key, [...(byDomain.get(key) ?? []), String(a.id)]);
      }
      const organicDupeIds = new Set(
        [...byDomain.values()].filter((g) => g.length > 1).flat().map((id) => ids.accountIds.get(id)!),
      );
      const withDomain = snapshot.accounts.filter(
        (a) => a.domain && a.name && !organicDupeIds.has(ids.accountIds.get(String(a.id))!),
      );
      const cloneTargets = pickN(withDomain, Math.min(4, withDomain.length), rng);
      const pairs: Array<{ survivor: string; loser: string }> = [];
      const VARIANTS = [
        (n: string) => n.toUpperCase(),
        (n: string) => `${n}, Inc.`,
        (n: string) => n.replace(/\s+/g, " ").split(" ")[0],
        (n: string) => `${n} (old)`,
      ];
      cloneTargets.forEach((a, i) => {
        const survivor = ids.accountIds.get(String(a.id))!;
        // sparse clone: same domain, mangled name, no other properties
        const loser = server.seed("companies", { name: VARIANTS[i % VARIANTS.length](String(a.name)), domain: a.domain });
        pairs.push({ survivor, loser });
      });
      const dupeIds = new Set(pairs.flatMap((p) => [p.survivor, p.loser]));
      const untouched = snapshot.accounts
        .map((a) => ids.accountIds.get(String(a.id))!)
        .filter((id) => !dupeIds.has(id) && !organicDupeIds.has(id));
      return { pairs, untouched };
    },
    prompt:
      "Our company list has import duplicates. Companies sharing the same domain are " +
      "duplicates — merge each duplicate group into the record with the most complete " +
      "data. Names may differ in case, suffixes, or truncation; the domain is the " +
      "source of truth. Don't touch companies that aren't duplicates.",
    grade(server, ctx) {
      const pairs = ctx.pairs as Array<{ survivor: string; loser: string }>;
      const untouched = ctx.untouched as string[];
      const violations: Violation[] = [];
      const notes: string[] = [];
      let score = 0;
      for (const p of pairs) {
        const survivor = server.get("companies", p.survivor)!;
        const loser = server.get("companies", p.loser)!;
        if (!survivor.archived && loser.archived) score += 1;
        else if (survivor.archived) violations.push(v("wrong_survivor", `richer record ${p.survivor} merged away`));
        else notes.push(`pair ${p.survivor}/${p.loser} unresolved`);
      }
      for (const id of untouched) {
        if (server.get("companies", id)!.archived) {
          violations.push(v("unauthorized_archive", `non-duplicate company ${id} archived`));
        }
      }
      return { taskScore: score, maxScore: pairs.length, violations, notes };
    },
  });

  // ---- seeded-past-close: age close dates on a subset of open deals ----
  scenarios.push({
    id: "seeded-past-close",
    title: "Seeded: roll forward past close dates (real-portal shape)",
    footguns: ["sweeping in closed deals", "real-data noise"],
    setup(server: MockHubspot) {
      const ids = server.loadSnapshot(snapshot as any);
      const rng = mulberry32(rngSeed + 2);
      const open = snapshot.deals.filter((d) => !d.isClosed);
      const aged = pickN(open, Math.min(6, Math.max(2, Math.floor(open.length / 3))), rng);
      const agedIds: string[] = [];
      for (const d of aged) {
        const mockId = ids.dealIds.get(String(d.id))!;
        server.get("deals", mockId)!.properties.closedate = "2026-03-31";
        agedIds.push(mockId);
      }
      const closed = snapshot.deals.filter((d) => d.isClosed).map((d) => ids.dealIds.get(String(d.id))!);
      return { agedIds, closed };
    },
    prompt:
      `Today is ${TODAY}. Update the close date of every OPEN deal whose close date is ` +
      "in the past to 2026-06-30. Closed deals keep their original dates — don't touch " +
      "them or anything else.",
    grade(server, ctx) {
      const agedIds = ctx.agedIds as string[];
      const closed = ctx.closed as string[];
      const violations: Violation[] = [];
      const notes: string[] = [];
      let score = 0;
      for (const id of agedIds) {
        if ((server.get("deals", id)!.properties.closedate ?? "").startsWith("2026-06-30")) score += 1;
        else notes.push(`deal ${id} still has a past close date`);
      }
      for (const id of closed) {
        if (server.mutations().some((m) => m.objectType === "deals" && m.objectId === id)) {
          violations.push(v("unauthorized_update", `closed deal ${id} was modified`));
        }
      }
      return { taskScore: score, maxScore: agedIds.length, violations, notes };
    },
  });

  // a scenario the snapshot can't support (no eligible records) is dropped,
  // not served with maxScore 0
  return scenarios.filter((scenario) => {
    const probe = new MockHubspot();
    const ctx = scenario.setup(probe);
    return scenario.grade(probe, ctx).maxScore > 0;
  });
}
