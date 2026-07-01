/**
 * `tam` — Total Addressable Market mapping.
 *
 * Market mapping (`market`) answers "who else is in this category and where are
 * the open fronts." TAM mapping answers a different, longer-horizon question:
 * "how big is the reachable market for *my* ICP, and how far along am I in
 * actually putting it in the CRM?"
 *
 * It is deliberately NOT a one-shot "$10B TAM" headline. The flow is iterative:
 *   1. `tam estimate` — derive a defensible universe from the ICP: a real
 *      account count (a discovery provider's total-match for the ICP filter, or
 *      an explicit assumption), × ACV for the dollar figure, with buyers/account
 *      giving the *contact* population target. Citable cross-checks optional.
 *   2. `tam populate` — schedule governed `enrich acquire --save` runs that chip
 *      away at the universe (plan-only; apply stays a separate human gate).
 *   3. `tam status` / `tam report` — coverage over time: accounts/contacts/$
 *      in the CRM vs. the universe, what THIS campaign added since baseline, and
 *      an ETA at the current burn rate — so "it'll take a while" is quantified.
 *
 * This module is the pure, deterministic core (estimation + coverage + ETA math
 * + a profile-scoped store). The CLI wires it to the ICP, the CRM snapshot, the
 * discovery providers, and the scheduler.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.js";
export function estimateTam(input) {
    if (!Number.isFinite(input.accounts) || input.accounts < 0) {
        throw new Error(`tam: account universe must be a non-negative number (got ${input.accounts})`);
    }
    if (!Number.isFinite(input.acv.valueUsd) || input.acv.valueUsd <= 0) {
        throw new Error(`tam: ACV must be a positive number (got ${input.acv.valueUsd}) — a TAM needs a real ACV`);
    }
    const buyersPerAccount = input.buyersPerAccount ?? 1;
    if (!Number.isFinite(buyersPerAccount) || buyersPerAccount <= 0) {
        throw new Error(`tam: buyers-per-account must be positive (got ${buyersPerAccount})`);
    }
    const accounts = Math.round(input.accounts);
    const contacts = Math.round(accounts * buyersPerAccount);
    const basis = input.acv.basis ?? "account";
    const tamUsd = Math.round((basis === "buyer" ? contacts : accounts) * input.acv.valueUsd);
    return {
        name: input.name,
        icpName: input.icpName,
        universe: {
            accounts,
            accountsSource: input.accountsSource,
            buyersPerAccount,
            buyersSource: input.buyersSource ?? "explicit",
            contacts,
        },
        ...(input.targeting ? { targeting: input.targeting } : {}),
        acv: { basis, valueUsd: input.acv.valueUsd, source: input.acv.source ?? "explicit" },
        tamUsd,
        crossChecks: input.crossChecks ?? [],
        baseline: input.baseline,
        createdAt: input.createdAt,
    };
}
// ── Deriving real signal from the CRM (no fabricated defaults) ─────────────────
function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * Derive a real ACV from the CRM's closed-won deals (median amount — robust to
 * outliers). Returns null when there are no usable won deals, so the caller can
 * refuse to fabricate a dollar TAM. The median is the headline; the mean is
 * surfaced too so a skewed pipeline is visible.
 */
export function deriveAcvFromClosedWon(snapshot) {
    const amounts = (snapshot.deals ?? [])
        .filter((d) => d.isWon === true && typeof d.amount === "number" && Number.isFinite(d.amount) && d.amount > 0)
        .map((d) => d.amount);
    if (amounts.length === 0)
        return null;
    const meanUsd = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    return { valueUsd: Math.round(median(amounts)), dealCount: amounts.length, meanUsd };
}
/**
 * Derive buyers/account from the CRM: the average number of contacts on accounts
 * that have at least one. A real proxy for the buying group, vs. a hardcoded
 * guess. Returns null when no account has a contact.
 */
export function deriveBuyersPerAccount(snapshot) {
    const perAccount = new Map();
    for (const c of snapshot.contacts ?? []) {
        if (c.accountId)
            perAccount.set(c.accountId, (perAccount.get(c.accountId) ?? 0) + 1);
    }
    if (perAccount.size === 0)
        return null;
    const total = [...perAccount.values()].reduce((a, b) => a + b, 0);
    return { value: Math.round((total / perAccount.size) * 10) / 10, accountsSampled: perAccount.size };
}
// ── Coverage (pure) ───────────────────────────────────────────────────────────
/**
 * Count what "fills" the TAM from a CRM snapshot: accounts that carry a domain
 * (real, signal-watchable records — a name-only stub doesn't count) and the
 * contacts at them. Coverage is measured against these, so a TAM you've started
 * filling reads truthfully even for accounts that pre-dated the campaign.
 */
export function coverageCountsFromSnapshot(snapshot) {
    const accounts = (snapshot.accounts ?? []).filter((a) => Boolean(a.domain && a.domain.trim())).length;
    const contacts = (snapshot.contacts ?? []).length;
    return { accounts, contacts };
}
const cap1 = (n) => (n <= 0 ? 0 : n >= 1 ? 1 : n);
function parseBand(band) {
    const plus = /^(\d+)\+$/.exec(band.trim());
    if (plus)
        return [Number(plus[1]), Number.POSITIVE_INFINITY];
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(band.trim());
    if (range)
        return [Number(range[1]), Number(range[2])];
    return null;
}
function employeeCountInBands(count, bands) {
    return bands.some((b) => {
        const r = parseBand(b);
        return r ? count >= r[0] && count <= r[1] : false;
    });
}
function industryMatches(accountIndustry, tamIndustries) {
    const a = accountIndustry.toLowerCase();
    return tamIndustries.some((i) => {
        const t = i.toLowerCase().trim();
        return t.length > 0 && (a.includes(t) || t.includes(a));
    });
}
/** The TAM criteria checkable from a CanonicalAccount — geo/technology are NOT on
 *  the record, so they need re-enrichment and are excluded here. */
export function crmCheckableCriteria(t) {
    const c = [];
    if (t.employeeBands?.length)
        c.push("size");
    if (t.industries?.length)
        c.push("industry");
    return c;
}
/**
 * Classify one CRM account against the TAM ICP, using only CRM-checkable criteria
 * (size, industry). "out" if any criterion contradicts (wrong size/industry);
 * "in" if at least one passes and none contradict; "unknown" if nothing could be
 * evaluated (missing fields, or the TAM is defined only by geo/technology). Note:
 * geo + "uses a CRM" can't be confirmed from a CanonicalAccount, so an "in" here
 * means "matches what the CRM lets us check" — not a full technographic match.
 */
export function classifyAccount(account, t) {
    let pass = 0;
    let fail = 0;
    let checkable = 0;
    if (t.employeeBands?.length) {
        checkable++;
        if (typeof account.employeeCount === "number" && Number.isFinite(account.employeeCount)) {
            if (employeeCountInBands(account.employeeCount, t.employeeBands))
                pass++;
            else
                fail++;
        }
    }
    if (t.industries?.length) {
        checkable++;
        if (account.industry && account.industry.trim()) {
            if (industryMatches(account.industry, t.industries))
                pass++;
            else
                fail++;
        }
    }
    if (checkable === 0)
        return "unknown"; // TAM is geo/technology-only → not CRM-checkable
    if (fail > 0)
        return "out";
    if (pass > 0)
        return "in";
    return "unknown"; // criteria specified but the account had no data for them
}
/**
 * Coverage that classifies CRM accounts against THIS TAM's ICP — so accounts
 * loaded from anywhere that DON'T match the target market (wrong size/industry)
 * land in out-of-TAM/unknown and never inflate coverage. Reconciles bottom-up vs
 * top-down: the in-TAM count is a FLOOR on the real universe (you've verified
 * those exist), so when it exceeds the estimate, the estimate was low.
 */
export function classifyCoverage(model, snapshot, at) {
    const accounts = (snapshot.accounts ?? []).filter((a) => Boolean(a.domain && a.domain.trim()));
    const totalCrm = accounts.length;
    const allContacts = (snapshot.contacts ?? []).length;
    const t = model.targeting;
    const criteria = t ? crmCheckableCriteria(t) : [];
    let inTam = totalCrm;
    let outOfTam = 0;
    let unknown = 0;
    const inTamIds = new Set(accounts.map((a) => a.id)); // legacy default: all in
    if (t && criteria.length > 0) {
        inTam = 0;
        inTamIds.clear();
        for (const a of accounts) {
            const klass = classifyAccount(a, t);
            if (klass === "in") {
                inTam++;
                inTamIds.add(a.id);
            }
            else if (klass === "out") {
                outOfTam++;
            }
            else {
                unknown++;
            }
        }
    }
    const inTamContacts = criteria.length > 0
        ? (snapshot.contacts ?? []).filter((c) => c.accountId && inTamIds.has(c.accountId)).length
        : allContacts;
    const accountCoverage = model.universe.accounts > 0 ? cap1(inTam / model.universe.accounts) : 0;
    const contactCoverage = model.universe.contacts > 0 ? cap1(inTamContacts / model.universe.contacts) : 0;
    return {
        at,
        universe: { accounts: model.universe.accounts, contacts: model.universe.contacts, tamUsd: model.tamUsd },
        inCrm: { accounts: totalCrm, contacts: allContacts },
        addedSinceBaseline: {
            accounts: Math.max(0, totalCrm - model.baseline.accounts),
            contacts: Math.max(0, allContacts - model.baseline.contacts),
        },
        accountCoverage,
        contactCoverage,
        dollarCovered: Math.round(accountCoverage * model.tamUsd),
        classified: { inTam, outOfTam, unknown, totalCrm, criteria },
        reconciledUniverse: Math.max(model.universe.accounts, inTam),
        bottomUpExceedsEstimate: inTam > model.universe.accounts,
    };
}
/** The covered-account count a coverage reading represents: in-TAM when
 *  classified, else the raw CRM count (legacy). Used for ETA + reconciliation. */
export function coveredAccounts(c) {
    return c.classified ? c.classified.inTam : c.inCrm.accounts;
}
export function computeCoverage(model, inCrm, at) {
    const accountCoverage = model.universe.accounts > 0 ? cap1(inCrm.accounts / model.universe.accounts) : 0;
    const contactCoverage = model.universe.contacts > 0 ? cap1(inCrm.contacts / model.universe.contacts) : 0;
    return {
        at,
        universe: { accounts: model.universe.accounts, contacts: model.universe.contacts, tamUsd: model.tamUsd },
        inCrm,
        addedSinceBaseline: {
            accounts: Math.max(0, inCrm.accounts - model.baseline.accounts),
            contacts: Math.max(0, inCrm.contacts - model.baseline.contacts),
        },
        accountCoverage,
        contactCoverage,
        dollarCovered: Math.round(accountCoverage * model.tamUsd),
    };
}
const MS_PER_DAY = 86_400_000;
/**
 * Project when the account universe is filled, from the coverage timeline. Uses
 * the first and last readings that show real movement. Returns null when there
 * isn't enough signal (fewer than two readings, no elapsed time, or a flat/
 * negative burn rate) — an honest "can't project yet" rather than a fake date.
 */
export function projectEta(model, timeline) {
    if (timeline.length < 2)
        return null;
    const sorted = [...timeline].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const elapsedDays = (Date.parse(last.at) - Date.parse(first.at)) / MS_PER_DAY;
    if (!Number.isFinite(elapsedDays) || elapsedDays <= 0)
        return null;
    // Pace is measured on IN-TAM accounts (when classified) — off-ICP accounts
    // loaded from elsewhere don't count as progress toward THIS universe.
    const gained = coveredAccounts(last) - coveredAccounts(first);
    if (gained <= 0)
        return null;
    const accountsPerDay = gained / elapsedDays;
    const accountsRemaining = Math.max(0, model.universe.accounts - coveredAccounts(last));
    const daysRemaining = Math.ceil(accountsRemaining / accountsPerDay);
    const etaDate = new Date(Date.parse(last.at) + daysRemaining * MS_PER_DAY).toISOString().slice(0, 10);
    return {
        accountsPerDay: Math.round(accountsPerDay * 10) / 10,
        accountsRemaining,
        daysRemaining,
        etaDate,
        basis: `${gained} accounts over ${Math.round(elapsedDays)}d (${first.at.slice(0, 10)}→${last.at.slice(0, 10)})`,
    };
}
// ── Profile-scoped store ──────────────────────────────────────────────────────
function safeName(name) {
    if (!/^[\w.-]+$/.test(name))
        throw new Error(`tam: invalid name "${name}" (use letters, digits, . _ -)`);
    return name;
}
/** `$FSGTM_HOME[/profiles/<profile>]/tam/<name>/`. */
export function tamDir(name) {
    return join(credentialsDir(), "tam", safeName(name));
}
export function saveTamModel(model) {
    ensureSecureHomeDir();
    const dir = tamDir(model.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "model.json");
    writeSecureFile(path, `${JSON.stringify(model, null, 2)}\n`);
    return path;
}
export function loadTamModel(name) {
    try {
        return JSON.parse(readFileSync(join(tamDir(name), "model.json"), "utf8"));
    }
    catch {
        return null;
    }
}
/** Append a coverage reading to the TAM's append-only timeline (0600). */
export function appendCoverage(name, coverage) {
    ensureSecureHomeDir();
    const dir = tamDir(name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "coverage.jsonl"), `${JSON.stringify(coverage)}\n`, { mode: 0o600 });
}
/** Read the TAM's coverage timeline; tolerant of partial/corrupt lines. */
export function readCoverageTimeline(name) {
    let raw;
    try {
        raw = readFileSync(join(tamDir(name), "coverage.jsonl"), "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch {
            // skip a torn line rather than failing the rollup
        }
    }
    return out;
}
// ── Rendering ─────────────────────────────────────────────────────────────────
function usd(n) {
    if (n >= 1_000_000_000)
        return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000)
        return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `$${(n / 1_000).toFixed(0)}K`;
    return `$${Math.round(n)}`;
}
const pct = (x) => `${Math.round(x * 100)}%`;
/** A compact human summary for `tam status`. */
export function coverageToText(model, coverage, eta) {
    const c = coverage.classified;
    const lines = [
        `TAM "${model.name}" (ICP: ${model.icpName}) — ${model.acv.basis}-basis ACV ${usd(model.acv.valueUsd)} ` +
            `[${model.acv.source}]`,
        `Universe: ${model.universe.accounts.toLocaleString()} accounts (${model.universe.accountsSource}) / ` +
            `${model.universe.contacts.toLocaleString()} contacts ` +
            `(${model.universe.buyersPerAccount} buyers/account [${model.universe.buyersSource}]) / ${usd(model.tamUsd)}`,
    ];
    if (c && c.criteria.length > 0) {
        // Classified coverage: only in-TAM accounts count; junk is bucketed out.
        lines.push(`In CRM:   ${c.totalCrm.toLocaleString()} accounts → ${c.inTam.toLocaleString()} in-TAM (${pct(coverage.accountCoverage)}), ` +
            `${c.outOfTam.toLocaleString()} out-of-TAM, ${c.unknown.toLocaleString()} unknown`, `          (classified on ${c.criteria.join(" + ")}; geo + "uses-CRM" not CRM-verified)`, `$ covered: ${usd(coverage.dollarCovered)} of ${usd(model.tamUsd)} (${pct(coverage.accountCoverage)} of estimate)`);
        if (coverage.bottomUpExceedsEstimate) {
            lines.push(`⚠ Bottom-up exceeds the estimate: ${c.inTam.toLocaleString()} in-TAM accounts in CRM > ` +
                `${model.universe.accounts.toLocaleString()} estimated. The estimate was a FLOOR — your real market is ` +
                `at least ${(coverage.reconciledUniverse ?? c.inTam).toLocaleString()}. Re-estimate (broader ICP / better ` +
                `source) to find the remaining headroom.`);
        }
        if (c.unknown > 0) {
            lines.push(`  ${c.unknown.toLocaleString()} accounts couldn't be classified (missing ${c.criteria.join("/")} on the record) ` +
                "— enrich them, or they may be in- or out-of-TAM.");
        }
    }
    else {
        // Unclassified (legacy model with no targeting, or geo/tech-only ICP).
        lines.push(`In CRM:   ${coverage.inCrm.accounts.toLocaleString()} accounts (${pct(coverage.accountCoverage)}) / ` +
            `${coverage.inCrm.contacts.toLocaleString()} contacts (${pct(coverage.contactCoverage)})`, `  └ added since baseline: ${coverage.addedSinceBaseline.accounts.toLocaleString()} accounts / ` +
            `${coverage.addedSinceBaseline.contacts.toLocaleString()} contacts`, `$ covered: ${usd(coverage.dollarCovered)} of ${usd(model.tamUsd)} (${pct(coverage.accountCoverage)})`);
        if (coverage.classified) {
            lines.push(`  (counting ALL CRM accounts — this TAM has no CRM-checkable criteria (geo/technology only); ` +
                "re-estimate with size/industry in the ICP to classify in/out-of-TAM)");
        }
        else if (!model.targeting) {
            lines.push("  (counting ALL CRM accounts — re-run `tam estimate` to store the ICP filter and classify in/out-of-TAM)");
        }
    }
    if (eta) {
        lines.push(`Pace: ${eta.accountsPerDay}/day → ~${eta.daysRemaining} days to fill ` +
            `(${eta.accountsRemaining.toLocaleString()} accounts left, ETA ${eta.etaDate}; ${eta.basis})`);
    }
    else {
        lines.push(`Pace: not enough history to project an ETA yet — save another reading after some population runs.`);
    }
    if (model.crossChecks.length) {
        lines.push(`Cross-checks:`);
        for (const cc of model.crossChecks) {
            lines.push(`  • ${cc.claim}${cc.valueUsd ? ` (${usd(cc.valueUsd)})` : ""} — ${cc.sourceUrl}`);
        }
    }
    return lines.join("\n");
}
/** A client-ready markdown deliverable for `tam report`. */
export function tamReportToMarkdown(model, timeline, eta) {
    const latest = timeline.length ? timeline[timeline.length - 1] : computeCoverage(model, model.baseline, model.createdAt);
    const lines = [
        `# TAM map — ${model.name}`,
        "",
        `**ICP:** ${model.icpName}  ·  **Created:** ${model.createdAt.slice(0, 10)}`,
        "",
        "## The universe",
        "",
        `| | Estimate |`,
        `| --- | --- |`,
        `| Accounts | ${model.universe.accounts.toLocaleString()} (${model.universe.accountsSource}) |`,
        `| Buyers / account | ${model.universe.buyersPerAccount} (${model.universe.buyersSource}) |`,
        `| Contacts (population target) | ${model.universe.contacts.toLocaleString()} |`,
        `| ACV (${model.acv.basis} basis) | ${usd(model.acv.valueUsd)} (${model.acv.source}) |`,
        `| **TAM** | **${usd(model.tamUsd)}** |`,
        "",
    ];
    if (model.crossChecks.length) {
        lines.push("### Cross-checks (citable)", "");
        for (const c of model.crossChecks) {
            lines.push(`- **${c.claim}**${c.valueUsd ? ` — ${usd(c.valueUsd)}` : ""}  `);
            lines.push(`  > ${c.quote}  `);
            lines.push(`  [source](${c.sourceUrl})${c.asOf ? ` · ${c.asOf}` : ""}`);
        }
        lines.push("");
    }
    const cl = latest.classified;
    const inTamAccounts = cl && cl.criteria.length > 0 ? cl.inTam : latest.inCrm.accounts;
    lines.push("## Coverage", "", `| Dimension | In CRM (in-TAM) | Universe | Covered |`, `| --- | --- | --- | --- |`, `| Accounts | ${inTamAccounts.toLocaleString()} | ${latest.universe.accounts.toLocaleString()} | ${pct(latest.accountCoverage)} |`, `| Dollars | ${usd(latest.dollarCovered)} | ${usd(latest.universe.tamUsd)} | ${pct(latest.accountCoverage)} |`, "");
    if (cl && cl.criteria.length > 0) {
        lines.push(`Of **${cl.totalCrm.toLocaleString()}** CRM accounts: **${cl.inTam.toLocaleString()} in-TAM**, ` +
            `${cl.outOfTam.toLocaleString()} out-of-TAM, ${cl.unknown.toLocaleString()} unknown ` +
            `(classified on ${cl.criteria.join(" + ")}; geo + "uses-CRM" not CRM-verified).`, "");
        if (latest.bottomUpExceedsEstimate) {
            lines.push(`> ⚠ **Bottom-up exceeds the estimate.** ${cl.inTam.toLocaleString()} in-TAM accounts already in CRM > ` +
                `${model.universe.accounts.toLocaleString()} estimated — the estimate was a floor; the real universe is ` +
                `at least ${(latest.reconciledUniverse ?? cl.inTam).toLocaleString()}. Re-estimate to find the headroom.`, "");
        }
    }
    else {
        lines.push(`Added since baseline: **${latest.addedSinceBaseline.accounts.toLocaleString()} accounts**, ` +
            `**${latest.addedSinceBaseline.contacts.toLocaleString()} contacts**. ` +
            "_(All CRM accounts counted — no ICP filter stored; re-estimate to classify in/out-of-TAM.)_", "");
    }
    if (eta) {
        lines.push("## Pace & ETA", "", `At **${eta.accountsPerDay} accounts/day** (${eta.basis}), ~**${eta.daysRemaining} days** remain ` +
            `to cover the account universe (${eta.accountsRemaining.toLocaleString()} left) — projected **${eta.etaDate}**.`, "");
    }
    else {
        lines.push("## Pace & ETA", "", "_Not enough history to project yet._ Save another `tam status --save` reading after a few population runs.", "");
    }
    if (timeline.length >= 2) {
        lines.push("### Burn-up", "", `| Date | Accounts in CRM | Covered |`, `| --- | --- | --- |`);
        for (const c of timeline) {
            lines.push(`| ${c.at.slice(0, 10)} | ${c.inCrm.accounts.toLocaleString()} | ${pct(c.accountCoverage)} |`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
