import { computeFrontStates, diffFrontStates } from "./market.js";
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
function termPattern(terms) {
    const cleaned = terms.map((term) => term.trim()).filter(Boolean);
    if (cleaned.length === 0)
        return null;
    const escaped = cleaned.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
    return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}
/**
 * Deterministic claim/vendor mention statistics over a call corpus.
 * Claims match on their configured `terms` (claims without terms simply have
 * no mention stats — the directives that need mentions will not fire for
 * them); vendors match on name + configured `aliases`.
 */
export function computeOverlayStats(config, snapshot, documents) {
    const dealById = new Map(snapshot.deals.map((deal) => [deal.id, deal]));
    const closed = snapshot.deals.filter((deal) => deal.isClosed === true);
    const won = closed.filter((deal) => deal.isWon === true);
    const baselineWinRate = closed.length > 0 ? won.length / closed.length : null;
    const dealOutcome = (dealIds) => {
        let wonCount = 0;
        let lostCount = 0;
        for (const dealId of dealIds) {
            const deal = dealById.get(dealId);
            if (!deal || deal.isClosed !== true)
                continue;
            if (deal.isWon === true)
                wonCount += 1;
            else
                lostCount += 1;
        }
        return { wonCount, lostCount };
    };
    const claims = config.claims.map((claim) => {
        const pattern = termPattern(claim.terms ?? []);
        const mentionDocs = pattern ? documents.filter((doc) => pattern.test(doc.text)) : [];
        const mentionDealIds = [...new Set(mentionDocs.map((doc) => doc.dealId).filter((id) => !!id))];
        const { wonCount, lostCount } = dealOutcome(mentionDealIds);
        return {
            claimId: claim.id,
            mentionDocIds: mentionDocs.map((doc) => doc.id),
            mentionDealIds,
            wonDeals: wonCount,
            lostDeals: lostCount,
            winRateWhenMentioned: wonCount + lostCount > 0 ? wonCount / (wonCount + lostCount) : null,
        };
    });
    const vendors = config.vendors.map((vendor) => {
        const pattern = termPattern([vendor.name, ...(vendor.aliases ?? [])]);
        const mentionDocs = pattern ? documents.filter((doc) => pattern.test(doc.text)) : [];
        const mentionDealIds = [...new Set(mentionDocs.map((doc) => doc.dealId).filter((id) => !!id))];
        const { wonCount, lostCount } = dealOutcome(mentionDealIds);
        return {
            vendorId: vendor.id,
            mentionDocIds: mentionDocs.map((doc) => doc.id),
            mentionDealIds,
            wonWhenMentioned: wonCount,
            lostWhenMentioned: lostCount,
        };
    });
    return {
        documents: documents.length,
        documentsWithDeal: documents.filter((doc) => doc.dealId).length,
        deals: { total: snapshot.deals.length, closed: closed.length, won: won.length, baselineWinRate },
        claims,
        vendors,
    };
}
/**
 * Directive rules v1 — deterministic over (front states × overlay stats),
 * with explicit minimum-evidence thresholds so small samples cannot mint
 * strategy. Requires config.anchorVendor: directives are advice to someone.
 *
 *   OCCUPY  — open/vacant front the anchor doesn't own loudly, and buyers
 *             demonstrably talk about it (≥ minMentions documents).
 *   PROMOTE — anchor is quiet on a claim whose mentioned-deal win rate beats
 *             baseline by ≥ promoteLift (with ≥ minMentions mentioned deals).
 *   URGENT  — a front the anchor is loud on drifted toward saturation since
 *             the prior run (requires priorSet).
 *   RETREAT — saturated front the anchor is loud on, with zero presence in
 *             won-deal conversations despite a corpus that contains wins.
 */
export function computeDirectives(config, set, stats, options = {}) {
    const anchor = config.anchorVendor;
    if (!anchor)
        throw new Error("market overlay requires anchorVendor in the config — directives are advice to someone");
    const minMentions = options.minMentions ?? 3;
    const promoteLift = options.promoteLift ?? 0.1;
    const minWonDealsForRetreat = options.minWonDealsForRetreat ?? 3;
    const fronts = computeFrontStates(config, set);
    const frontByClaim = new Map(fronts.map((front) => [front.claimId, front]));
    const statsByClaim = new Map(stats.claims.map((claim) => [claim.claimId, claim]));
    const anchorIntensity = new Map();
    const loudObservationIds = new Map();
    for (const obs of set.observations) {
        if (obs.vendorId === anchor)
            anchorIntensity.set(obs.claimId, { intensity: obs.intensity, observationId: obs.id });
        if (obs.intensity === "loud") {
            const ids = loudObservationIds.get(obs.claimId) ?? [];
            ids.push(obs.id);
            loudObservationIds.set(obs.claimId, ids);
        }
    }
    const directives = [];
    const claimName = new Map(config.claims.map((claim) => [claim.id, claim.capability.split(":")[0]]));
    const push = (type, claimId, summary, recommendation, observationIds, statsList) => {
        directives.push({
            id: `dir_${fnv1a(`${config.category}|${set.runLabel}|${type}|${claimId}`)}`,
            type,
            claimId,
            title: `${type.toUpperCase()}: ${claimName.get(claimId) ?? claimId}`,
            summary,
            recommendation,
            observationIds: [...new Set(observationIds)].filter(Boolean),
            stats: statsList,
        });
    };
    for (const claim of config.claims) {
        const front = frontByClaim.get(claim.id);
        const mention = statsByClaim.get(claim.id);
        const anchorObs = anchorIntensity.get(claim.id);
        if (!front || !anchorObs)
            continue;
        if ((front.state === "open" || front.state === "vacant") &&
            (anchorObs.intensity === "absent" || anchorObs.intensity === "quiet") &&
            mention &&
            mention.mentionDocIds.length >= minMentions) {
            push("occupy", claim.id, `No vendor is loud on this claim, and it came up in ${mention.mentionDocIds.length} of ${stats.documents} call documents.`, `Claim it: buyers already talk about this and nobody owns the message. Anchor is currently ${anchorObs.intensity}.`, [anchorObs.observationId], [
                { name: "mention_documents", value: mention.mentionDocIds.length, n: stats.documents },
                { name: "front_state", value: front.state, n: config.vendors.length },
            ]);
        }
        if (anchorObs.intensity === "quiet" &&
            mention &&
            mention.winRateWhenMentioned !== null &&
            stats.deals.baselineWinRate !== null &&
            mention.wonDeals + mention.lostDeals >= minMentions &&
            mention.winRateWhenMentioned >= stats.deals.baselineWinRate + promoteLift) {
            push("promote", claim.id, `Anchor ships this quietly; deals where it comes up close at ${(mention.winRateWhenMentioned * 100).toFixed(0)}% vs ${(stats.deals.baselineWinRate * 100).toFixed(0)}% baseline.`, "Turn it loud: the conversion fingerprint says this claim wins deals when discussed.", [anchorObs.observationId], [
                { name: "win_rate_when_mentioned", value: Number(mention.winRateWhenMentioned.toFixed(3)), n: mention.wonDeals + mention.lostDeals },
                { name: "baseline_win_rate", value: Number(stats.deals.baselineWinRate.toFixed(3)), n: stats.deals.closed },
            ]);
        }
        if (front.state === "saturated" &&
            anchorObs.intensity === "loud" &&
            mention &&
            stats.deals.won >= minWonDealsForRetreat &&
            stats.documentsWithDeal > 0 &&
            mention.wonDeals === 0) {
            push("retreat", claim.id, `${front.loudVendorIds.length} vendors shout this claim; it appears in zero of the anchor's won-deal conversations (${stats.deals.won} won deals in corpus).`, "Stop spending message budget on a saturated front that never shows up in wins.", [anchorObs.observationId, ...(loudObservationIds.get(claim.id) ?? [])], [
                { name: "won_deals_mentioning", value: 0, n: stats.deals.won },
                { name: "loud_vendors", value: front.loudVendorIds.length, n: config.vendors.length },
            ]);
        }
    }
    if (options.priorSet) {
        const drift = diffFrontStates(computeFrontStates(config, options.priorSet), fronts);
        const toward = (before, after) => {
            const order = ["vacant", "open", "owned", "contested", "saturated"];
            return order.indexOf(after) > order.indexOf(before);
        };
        for (const change of drift) {
            const anchorObs = anchorIntensity.get(change.claimId);
            if (!anchorObs || anchorObs.intensity !== "loud" || !toward(change.before, change.after))
                continue;
            const mention = statsByClaim.get(change.claimId);
            push("urgent", change.claimId, `Front moved ${change.before} → ${change.after} since ${options.priorSet.runLabel} on a claim the anchor is loud on.`, "The window is closing: decide whether to defend (differentiate the claim) or bank the position before it saturates.", [anchorObs.observationId], [
                { name: "front_drift", value: `${change.before}→${change.after}`, n: config.vendors.length },
                { name: "mention_documents", value: mention?.mentionDocIds.length ?? 0, n: stats.documents },
            ]);
        }
    }
    return directives.sort((a, b) => a.type.localeCompare(b.type) || a.claimId.localeCompare(b.claimId));
}
/**
 * Emit directives as a standard dry-run patch plan: one approval-gated
 * create_task per directive against a designated CRM record (the company's
 * own account/deal record — directives are strategy tasks, and the CRM
 * needs somewhere to hang them). Approving and applying goes through the
 * normal plans → approve → apply gate; nothing here writes.
 */
export function directivesToPlan(config, set, directives, target, now = () => new Date()) {
    const createdAt = now().toISOString();
    const findings = directives.map((directive) => ({
        id: `find_${fnv1a(directive.id)}`,
        objectType: target.objectType,
        objectId: target.objectId,
        ruleId: `market_directive_${directive.type}`,
        title: directive.title,
        severity: directive.type === "urgent" ? "critical" : "warning",
        summary: directive.summary,
        recommendation: directive.recommendation,
        evidenceIds: directive.observationIds,
    }));
    const evidence = directives.map((directive) => ({
        id: `ev_${fnv1a(directive.id)}`,
        sourceSystem: "web",
        sourceObjectType: "market_map",
        sourceObjectId: `${config.category}/${set.runLabel}`,
        title: directive.title,
        text: `${directive.summary} Stats: ${directive.stats.map((stat) => `${stat.name}=${stat.value} (n=${stat.n})`).join("; ")}`,
        observedAt: set.runAt,
        metadata: { observationIds: directive.observationIds, stats: directive.stats },
    }));
    const operations = directives.map((directive) => ({
        id: `op_${fnv1a(directive.id)}`,
        objectType: target.objectType,
        objectId: target.objectId,
        operation: "create_task",
        field: "task",
        afterValue: `${directive.title} — ${directive.recommendation} (${directive.stats.map((stat) => `${stat.name}=${stat.value}, n=${stat.n}`).join("; ")})`,
        reason: directive.summary,
        riskLevel: "low",
        approvalRequired: true,
        sourceRuleOrPolicy: `market_directive_${directive.type}`,
        evidenceIds: [`ev_${fnv1a(directive.id)}`],
    }));
    return {
        id: `patch_plan_market_${fnv1a(`${config.category}|${set.runLabel}|${createdAt}`)}`,
        title: `Market directives — ${config.category} (${set.runLabel})`,
        createdAt,
        status: "needs_approval",
        dryRun: true,
        summary: `${directives.length} directive(s) from the ${config.category} market map joined to CRM ground truth.`,
        findings,
        evidence,
        operations,
    };
}
export function overlayToMarkdown(stats, directives) {
    const lines = [];
    lines.push(`Corpus: ${stats.documents} documents (${stats.documentsWithDeal} deal-linked) · ` +
        `${stats.deals.closed} closed deals, ${stats.deals.won} won` +
        (stats.deals.baselineWinRate !== null ? ` (baseline ${(stats.deals.baselineWinRate * 100).toFixed(0)}%)` : ""));
    lines.push("");
    if (directives.length === 0) {
        lines.push("No directives met the evidence thresholds. That is an answer, not a failure:");
        lines.push("either the corpus is too thin (add calls), or the current position needs no move.");
    }
    for (const directive of directives) {
        lines.push(`## ${directive.title}`);
        lines.push(directive.summary);
        lines.push(`→ ${directive.recommendation}`);
        lines.push(`evidence: ${directive.observationIds.length} observation(s) · ${directive.stats
            .map((stat) => `${stat.name}=${stat.value} (n=${stat.n})`)
            .join(" · ")}`);
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
}
