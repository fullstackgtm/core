import { readdirSync } from "node:fs";

let testFiles = [];
try {
  testFiles = readdirSync("tests").filter((name) => name.endsWith(".test.ts"));
} catch {
  // The package lives below the tests in the private monorepo.
}

if (testFiles.length === 0) {
  console.error(
    "No public tests were found. In the monorepo, run package tests from the repo root: " +
      "node --experimental-strip-types --test tests/fullstackgtm*.test.ts",
  );
  process.exit(1);
}

console.log(`Discovered ${testFiles.length} public test files.`);
