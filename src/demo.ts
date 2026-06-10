import type {
  CanonicalAccount,
  CanonicalActivity,
  CanonicalContact,
  CanonicalDeal,
  CanonicalGtmSnapshot,
  CanonicalUser,
} from "./types.ts";

export type DemoSnapshotOptions = {
  /** PRNG seed; the same seed always produces the same snapshot. */
  seed?: number;
  /** Anchor date (YYYY-MM-DD) all relative dates derive from. */
  today?: string;
  accounts?: number;
  deals?: number;
};

const FIRST_NAMES = [
  "Ava", "Marcus", "Priya", "Diego", "Sofia", "Jordan",
  "Mei", "Tomás", "Nia", "Ethan", "Lena", "Omar",
];
const LAST_NAMES = [
  "Calloway", "Reyes", "Iyer", "Novak", "Bennett", "Okafor",
  "Lindqvist", "Moreau", "Tanaka", "Whitfield", "Drummond", "Vargas",
];
const COMPANY_HEADS = [
  "Halcyon", "Northwind", "Cobalt", "Ridgeline", "Lumen", "Vantage",
  "Harbor", "Atlas", "Crestline", "Meridian", "Bluff", "Juniper",
  "Granite", "Summit", "Beacon",
];
const COMPANY_TAILS = [
  "Analytics", "Logistics", "Biotech", "Robotics", "Software",
  "Manufacturing", "Health", "Financial", "Media", "Systems",
  "Foods", "Energy", "Labs", "Dynamics",
];
const INDUSTRIES = [
  "SaaS", "Logistics", "Healthcare", "Manufacturing", "Financial Services",
  "Media", "Energy", "Retail",
];
const OPEN_STAGES = ["discovery", "qualification", "proposal", "negotiation"];
const DEAL_LABELS = [
  "Platform Subscription", "Enterprise Rollout", "Pilot Expansion",
  "Renewal", "Multi-Year Agreement", "Team Upgrade", "Add-On Seats",
];

/** Deterministic PRNG (mulberry32) so demo data is stable across runs. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shiftDate(today: string, days: number): string {
  const base = Date.parse(`${today}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Generate a realistic, deliberately messy mid-market CRM snapshot.
 *
 * The mess is injected at fixed indices so audits over a given seed produce
 * stable, testable findings, while the PRNG varies names, amounts, and dates:
 * - every 8th account is an orphan (no contacts, no deals)
 * - every 9th deal references a departed owner that no longer exists
 * - every 11th deal lost its account association
 * - open deals carry a realistic spread of past close dates and stale activity
 */
export function generateDemoSnapshot(options: DemoSnapshotOptions = {}): CanonicalGtmSnapshot {
  const seed = options.seed ?? 7;
  const today = options.today ?? "2026-06-09";
  const accountCount = options.accounts ?? 56;
  const dealCount = options.deals ?? 80;
  const random = mulberry32(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  const users: CanonicalUser[] = FIRST_NAMES.map((firstName, index) => ({
    id: `user_${String(index + 1).padStart(2, "0")}`,
    provider: "mock",
    crmId: `${9000 + index}`,
    name: `${firstName} ${LAST_NAMES[index]}`,
    email: `${firstName.toLowerCase()}.${LAST_NAMES[index].toLowerCase()}@example.com`,
    title: index === 0 ? "VP Sales" : index === 1 ? "Sales Manager" : "Account Executive",
    active: index < 10,
  }));
  const activeReps = users.slice(2, 10);

  const accounts: CanonicalAccount[] = [];
  for (let index = 0; index < accountCount; index += 1) {
    const name = `${COMPANY_HEADS[index % COMPANY_HEADS.length]} ${pick(COMPANY_TAILS)}`;
    accounts.push({
      id: `acct_${String(index + 1).padStart(3, "0")}`,
      provider: "mock",
      crmId: `${10_000 + index}`,
      name,
      domain: `${name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      industry: pick(INDUSTRIES),
      ownerId: random() < 0.85 ? pick(activeReps).id : undefined,
      employeeCount: between(40, 4000),
      annualRevenue: between(2, 400) * 1_000_000,
      lastSyncAt: shiftDate(today, -between(0, 3)),
    });
  }
  const orphanAccountIds = new Set(
    accounts.filter((_, index) => index % 8 === 0).map((account) => account.id),
  );
  const linkableAccounts = accounts.filter((account) => !orphanAccountIds.has(account.id));

  const contacts: CanonicalContact[] = [];
  for (const account of linkableAccounts) {
    const count = between(1, 3);
    for (let index = 0; index < count; index += 1) {
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      contacts.push({
        id: `contact_${String(contacts.length + 1).padStart(3, "0")}`,
        provider: "mock",
        crmId: `${20_000 + contacts.length}`,
        accountId: account.id,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}@${account.domain}`,
        title: pick(["CTO", "VP Operations", "Head of RevOps", "Director of IT", "CFO"]),
        ownerId: account.ownerId,
        lastSyncAt: account.lastSyncAt,
      });
    }
  }

  const deals: CanonicalDeal[] = [];
  const activities: CanonicalActivity[] = [];
  for (let index = 0; index < dealCount; index += 1) {
    const account = linkableAccounts[index % linkableAccounts.length];
    const departedOwner = index % 9 === 0;
    const unlinked = index % 11 === 0;
    const stageRoll = random();
    const stage =
      stageRoll < 0.7 ? pick(OPEN_STAGES) : stageRoll < 0.88 ? "closedwon" : "closedlost";
    const isWon = stage === "closedwon";
    const isClosed = isWon || stage === "closedlost";
    const closeDate = isClosed
      ? shiftDate(today, -between(5, 120))
      : shiftDate(today, between(-60, 150));
    const daysSinceActivity = isClosed ? between(5, 60) : between(0, 75);
    const lastActivityAt = shiftDate(today, -daysSinceActivity);

    const deal: CanonicalDeal = {
      id: `deal_${String(index + 1).padStart(3, "0")}`,
      provider: "mock",
      crmId: `${30_000 + index}`,
      accountId: unlinked ? undefined : account.id,
      ownerId: departedOwner ? `user_departed_${index % 2}` : (account.ownerId ?? pick(activeReps).id),
      name: `${account.name} — ${pick(DEAL_LABELS)}`,
      amount: between(8, 480) * 500,
      currency: "USD",
      stage,
      closeDate,
      forecastCategory: isWon ? "closed_won" : isClosed ? "closed_lost" : "pipeline",
      probability: isClosed ? (isWon ? 1 : 0) : between(10, 80) / 100,
      isClosed,
      isWon,
      lastActivityAt,
      lastSyncAt: shiftDate(today, -between(0, 2)),
    };
    deals.push(deal);

    const activityCount = Math.max(1, 3 - Math.floor(daysSinceActivity / 25));
    for (let activityIndex = 0; activityIndex < activityCount; activityIndex += 1) {
      activities.push({
        id: `activity_${String(activities.length + 1).padStart(4, "0")}`,
        provider: "mock",
        dealId: deal.id,
        accountId: deal.accountId,
        ownerId: deal.ownerId,
        type: pick(["call", "email", "meeting"] as const),
        occurredAt: shiftDate(today, -(daysSinceActivity + activityIndex * between(3, 12))),
        subject: pick([
          "Discovery call", "Pricing discussion", "Security review",
          "Champion sync", "Procurement follow-up", "Executive alignment",
        ]),
      });
    }
  }

  return {
    generatedAt: `${today}T00:00:00.000Z`,
    provider: "mock",
    users,
    accounts,
    contacts,
    deals,
    activities,
  };
}
