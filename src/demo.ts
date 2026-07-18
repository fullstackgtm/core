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
const DEMO_COMPANIES = [
  ["Apple", "apple.com"], ["Apple, Inc.", "apple.com"],
  ["Nike", "nike.com"], ["Nike, Inc.", "nike.com"],
  ["Starbucks", "starbucks.com"], ["Starbucks Corporation", "starbucks.com"],
  ["Microsoft", "microsoft.com"], ["Adobe", "adobe.com"],
  ["Salesforce", "salesforce.com"], ["HubSpot", "hubspot.com"],
  ["Atlassian", "atlassian.com"], ["Shopify", "shopify.com"],
  ["Zoom", "zoom.us"], ["Dropbox", "dropbox.com"], ["Canva", "canva.com"],
  ["Notion", "notion.so"], ["Slack", "slack.com"], ["Twilio", "twilio.com"],
  ["Zendesk", "zendesk.com"], ["DocuSign", "docusign.com"], ["Okta", "okta.com"],
  ["Snowflake", "snowflake.com"], ["Datadog", "datadoghq.com"], ["Asana", "asana.com"],
  ["Monday.com", "monday.com"], ["Intercom", "intercom.com"], ["Klaviyo", "klaviyo.com"],
  ["Mailchimp", "mailchimp.com"], ["Braze", "braze.com"], ["Iterable", "iterable.com"],
  ["Hootsuite", "hootsuite.com"], ["Sprout Social", "sproutsocial.com"],
  ["Figma", "figma.com"], ["Airtable", "airtable.com"], ["Stripe", "stripe.com"],
  ["Square", "squareup.com"], ["Intuit", "intuit.com"], ["DoorDash", "doordash.com"],
  ["Airbnb", "airbnb.com"], ["Uber", "uber.com"], ["Lyft", "lyft.com"],
  ["Peloton", "onepeloton.com"], ["Warby Parker", "warbyparker.com"],
  ["Allbirds", "allbirds.com"], ["Glossier", "glossier.com"], ["Casper", "casper.com"],
  ["Wayfair", "wayfair.com"], ["Chewy", "chewy.com"], ["Instacart", "instacart.com"],
  ["Reddit", "reddit.com"], ["Pinterest", "pinterest.com"], ["Spotify", "spotify.com"],
  ["Netflix", "netflix.com"], ["Disney", "disney.com"], ["LEGO", "lego.com"],
  ["Patagonia", "patagonia.com"],
] as const;
const COMPANY_HEADS = ["Acorn", "Bluebird", "Copper", "Evergreen", "Juniper", "Lighthouse", "Summit"];
const COMPANY_TAILS = ["Analytics", "Commerce", "Health", "Logistics", "Media", "Software", "Systems"];
const INDUSTRIES = [
  "Software", "Retail", "Consumer Goods", "Media", "Financial Services",
  "Travel & Hospitality", "E-commerce",
];
const OPEN_STAGES = ["discovery", "qualification", "proposal", "negotiation"];
const DEAL_LABELS = [
  "Marketing Automation Platform", "Lifecycle Marketing Rollout",
  "Customer Journey Pilot", "Annual Renewal", "Enterprise Automation Agreement",
  "Campaign Operations Expansion", "Additional Marketing Seats",
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

/** Build a deterministic, checksum-valid Salesforce 18-character record ID. */
function salesforceId(prefix: "001" | "003" | "005" | "006" | "00T", sequence: number): string {
  const token = `8Z${sequence.toString(36).padStart(10, "0")}`;
  const base = `${prefix}${token}`;
  const checksumAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  let checksum = "";
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let flags = 0;
    for (let position = 0; position < 5; position += 1) {
      const character = base[chunk * 5 + position];
      if (character >= "A" && character <= "Z") flags |= 1 << position;
    }
    checksum += checksumAlphabet[flags];
  }
  return `${base}${checksum}`;
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
    id: salesforceId("005", index + 1),
    provider: "mock",
    crmId: salesforceId("005", index + 1),
    name: `${firstName} ${LAST_NAMES[index]}`,
    email: `${firstName.toLowerCase()}.${LAST_NAMES[index].toLowerCase()}@acmesoftware.com`,
    title: index === 0 ? "VP Sales" : index === 1 ? "Sales Manager" : "Account Executive",
    active: index < 10,
  }));
  const activeReps = users.slice(2, 10);

  const accounts: CanonicalAccount[] = [];
  for (let index = 0; index < accountCount; index += 1) {
    const featured = DEMO_COMPANIES[index];
    // Consume the same PRNG draw for featured and overflow records so changing
    // display names never shifts the deterministic issue injection downstream.
    const generatedName = `${COMPANY_HEADS[index % COMPANY_HEADS.length]} ${pick(COMPANY_TAILS)} ${index + 1}`;
    const name = featured?.[0] ?? generatedName;
    const domain = featured?.[1] ?? `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.example`;
    accounts.push({
      id: salesforceId("001", index + 1),
      provider: "mock",
      crmId: salesforceId("001", index + 1),
      name,
      domain,
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
        id: salesforceId("003", contacts.length + 1),
        provider: "mock",
        crmId: salesforceId("003", contacts.length + 1),
        accountId: account.id,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${account.domain}`,
        title: pick(["Chief Marketing Officer", "VP Marketing", "Head of Growth", "Director of Lifecycle Marketing", "VP Demand Generation", "Marketing Operations Director"]),
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
      id: salesforceId("006", index + 1),
      provider: "mock",
      crmId: salesforceId("006", index + 1),
      accountId: unlinked ? undefined : account.id,
      ownerId: departedOwner ? salesforceId("005", 901 + index % 2) : (account.ownerId ?? pick(activeReps).id),
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
        id: salesforceId("00T", activities.length + 1),
        provider: "mock",
        dealId: deal.id,
        accountId: deal.accountId,
        ownerId: deal.ownerId,
        type: pick(["call", "email", "meeting"] as const),
        occurredAt: shiftDate(today, -(daysSinceActivity + activityIndex * between(3, 12))),
        subject: pick([
          "Marketing operations discovery", "Campaign workflow review",
          "Lifecycle strategy session", "Data integration review",
          "Attribution requirements", "Executive marketing alignment",
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
