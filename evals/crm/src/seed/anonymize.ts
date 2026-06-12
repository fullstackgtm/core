/**
 * Deterministic snapshot anonymizer: real CRM exports become benchmark seeds
 * without leaking customer data. Same input → same output (stable pseudonym
 * per original value), and identity relationships survive — two records that
 * shared a domain/email before still share one after, so dedupe scenarios
 * generated from the result keep their ground truth.
 *
 * Amounts, stages, dates, and record graph (owner/account links) are kept:
 * they're the "shape" realism the seeds exist to capture.
 */
// same relative depth in monorepo (packages/fullstackgtm/) and public mirror (repo root)
import type { CanonicalGtmSnapshot } from "../../../../src/types.ts";

const FIRST = ["Avery", "Blake", "Carmen", "Devon", "Elif", "Farid", "Greta", "Hugo", "Imani", "Jonas", "Keiko", "Liam", "Mara", "Nico", "Oluwaseun", "Petra", "Quinn", "Rosa", "Sven", "Tara", "Umar", "Vera", "Wes", "Ximena", "Yusuf", "Zofia"];
const LAST = ["Abebe", "Brandt", "Castillo", "Dunn", "Eriksen", "Fontaine", "Garza", "Hoffman", "Ito", "Jansen", "Kowalski", "Lindqvist", "Moreau", "Novak", "Okafor", "Petrov", "Quirke", "Rossi", "Santos", "Takahashi", "Ueda", "Varga", "Weber", "Xu", "Yilmaz", "Zhang"];
const COMPANY_A = ["Apex", "Borealis", "Cobalt", "Drift", "Ember", "Fathom", "Granite", "Harbor", "Iron", "Juniper", "Krait", "Lumen", "Meridian", "Nimbus", "Onyx", "Pinnacle", "Quartz", "Ridge", "Summit", "Tidal", "Umber", "Vantage", "Willow", "Xenon", "Yonder", "Zephyr"];
const COMPANY_B = ["Analytics", "Biosciences", "Capital", "Dynamics", "Energy", "Freight", "Group", "Holdings", "Industries", "Junction", "Kinetics", "Labs", "Manufacturing", "Networks", "Outfitters", "Partners", "Robotics", "Systems", "Technologies", "Ventures", "Works"];

function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(list: T[], key: string): T {
  return list[hash32(key) % list.length];
}

export function anonymizeSnapshot(snapshot: CanonicalGtmSnapshot): CanonicalGtmSnapshot {
  // stable maps so the SAME original value always becomes the SAME pseudonym
  const domainMap = new Map<string, string>();
  const emailMap = new Map<string, string>();

  const anonDomain = (domain: string | undefined): string | undefined => {
    if (!domain) return undefined;
    const key = domain.trim().toLowerCase();
    if (!domainMap.has(key)) {
      domainMap.set(key, `${pick(COMPANY_A, key).toLowerCase()}${pick(COMPANY_B, key + "b").toLowerCase()}-${(hash32(key) % 9000 + 1000)}.example`);
    }
    return domainMap.get(key);
  };
  const anonCompanyName = (name: string, id: string): string =>
    `${pick(COMPANY_A, name.toLowerCase().trim() || id)} ${pick(COMPANY_B, (name.toLowerCase().trim() || id) + "b")}`;
  const anonEmail = (email: string | undefined): string | undefined => {
    if (!email) return undefined;
    const key = email.trim().toLowerCase();
    if (!emailMap.has(key)) {
      const [, domainPart = "unknown.example"] = key.split("@");
      const first = pick(FIRST, key).toLowerCase();
      const last = pick(LAST, key + "l").toLowerCase();
      emailMap.set(key, `${first}.${last}@${anonDomain(domainPart)}`);
    }
    return emailMap.get(key);
  };

  return {
    ...snapshot,
    generatedAt: snapshot.generatedAt,
    users: snapshot.users.map((u) => ({
      ...u,
      name: `${pick(FIRST, u.id)} ${pick(LAST, u.id + "l")}`,
      email: anonEmail(u.email),
    })),
    accounts: snapshot.accounts.map((a) => ({
      ...a,
      name: anonCompanyName(a.name, a.id),
      domain: anonDomain(a.domain),
      raw: undefined,
    })),
    contacts: snapshot.contacts.map((c) => ({
      ...c,
      firstName: c.firstName ? pick(FIRST, (c.email ?? c.id) + "f") : c.firstName,
      lastName: c.lastName ? pick(LAST, (c.email ?? c.id) + "l") : c.lastName,
      email: anonEmail(c.email),
      phone: c.phone ? "+1-555-0100" : undefined,
      raw: undefined,
    })),
    deals: snapshot.deals.map((d) => {
      const account = snapshot.accounts.find((a) => a.id === d.accountId);
      const accountAnon = account ? anonCompanyName(account.name, account.id) : "Unlinked";
      return {
        ...d,
        // keep the "<Company> – <descriptor>" convention, lose the real names
        name: `${accountAnon} – ${pick(["Expansion", "Renewal", "New Business", "Pilot", "Platform", "Annual"], d.id)}`,
        nextStep: d.nextStep ? "Follow up per playbook" : undefined,
        raw: undefined,
      };
    }),
    activities: [],
  };
}
