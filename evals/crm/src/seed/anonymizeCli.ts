/**
 * Anonymize a canonical snapshot into a benchmark seed.
 *   npm run anonymize -- <snapshot.json> <out.json>
 * Keep real-portal-derived seeds out of git (seeds/ is gitignored) — they
 * are the private, contamination-resistant held-out set.
 */
import { readFile, writeFile } from "node:fs/promises";
import { anonymizeSnapshot } from "./anonymize.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: npm run anonymize -- <snapshot.json> <out.json>");
  process.exit(1);
}
const snapshot = JSON.parse(await readFile(input, "utf8"));
const anonymized = anonymizeSnapshot(snapshot);
await writeFile(output, JSON.stringify(anonymized, null, 2));
console.log(
  `${anonymized.accounts.length} accounts, ${anonymized.contacts.length} contacts, ${anonymized.deals.length} deals → ${output}`,
);
