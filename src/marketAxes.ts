import type { MarketAxis, MarketConfig, MarketObservation, ObservationSet } from "./market.ts";

/**
 * Axis discovery for a market map — the method that earns a strategic 2x2
 * instead of asserting one. Axes are claim-scoring rubrics in the config
 * (reviewable, versioned); a vendor's position on an axis is the
 * intensity-weighted mean of the scores of claims it voices. Two checks keep
 * axes honest, both computed deterministically from the stored observations:
 *
 *  1. Triangulation — PCA over the vendor × claim intensity matrix gives the
 *     category's own top variance directions; a real axis correlates with a
 *     principal component (it is derivable from the data, not just felt).
 *  2. Orthogonality — two configured axes that correlate ≥ ~0.75 at the
 *     vendor level are one axis twice. Sometimes that redundancy is the
 *     finding: the category couples the two ideas, and the empty quadrant is
 *     the strategic white space.
 *
 * Everything here is pure math over the store: same observations, same map.
 */

export const VOICE_WEIGHT: Record<string, number> = { loud: 1.0, quiet: 0.5 };

/**
 * Intensity-weighted mean of claim scores over claims the vendor voices.
 * Claims scored null on the axis are excluded; returns null if the vendor
 * voices nothing scoreable (e.g. fully unobservable).
 */
export function axisPosition(
  vendorId: string,
  claimScores: Record<string, number | null>,
  observations: MarketObservation[],
): number | null {
  let num = 0;
  let den = 0;
  for (const obs of observations) {
    if (obs.vendorId !== vendorId) continue;
    const score = claimScores[obs.claimId];
    if (score === null || score === undefined) continue;
    const weight = VOICE_WEIGHT[obs.intensity] ?? 0;
    if (weight > 0) {
      num += score * weight;
      den += weight;
    }
  }
  return den > 0 ? num / den : null;
}

/** Share of the claim space voiced (loud + half-weight quiet) over observable claims. */
export function messageBreadth(
  vendorId: string,
  observations: MarketObservation[],
): { breadth: number | null; loudCount: number } {
  let voiced = 0;
  let observable = 0;
  let loudCount = 0;
  for (const obs of observations) {
    if (obs.vendorId !== vendorId) continue;
    if (obs.intensity === "unobservable") continue;
    observable += 1;
    voiced += VOICE_WEIGHT[obs.intensity] ?? 0;
    if (obs.intensity === "loud") loudCount += 1;
  }
  return { breadth: observable > 0 ? voiced / observable : null, loudCount };
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((sum, x) => sum + x, 0) / n;
  const my = ys.reduce((sum, y) => sum + y, 0) / n;
  const sx = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
  if (!sx || !sy) return 0;
  return xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / (sx * sy);
}

// ---------------------------------------------------------------------------
// PCA — power iteration over the column-centered vendor × claim weight
// matrix. Pure and dependency-free; two components are all the canvas needs
// (PC1 should recover the category's primary axis; PC2 is the
// maximum-differentiation direction orthogonal to it).

export type PrincipalComponent = {
  /** claimId → loading. Sign is arbitrary; read poles from the extremes. */
  loadings: Array<{ claimId: string; loading: number }>;
  /** vendorId → score on this component. */
  scores: Array<{ vendorId: string; score: number }>;
};

export function pcaTop2(
  config: MarketConfig,
  set: ObservationSet,
): { vendors: string[]; pc1: PrincipalComponent; pc2: PrincipalComponent } {
  const claimIds = config.claims.map((claim) => claim.id);
  const byCell = new Map(set.observations.map((obs) => [`${obs.vendorId}|${obs.claimId}`, obs]));
  // Exclude fully-unobservable vendors: they carry no information, only zeros.
  const vendors = config.vendors
    .map((vendor) => vendor.id)
    .filter((vendorId) =>
      claimIds.some((claimId) => {
        const obs = byCell.get(`${vendorId}|${claimId}`);
        return obs !== undefined && obs.intensity !== "unobservable";
      }),
    );

  const matrix = vendors.map((vendorId) =>
    claimIds.map((claimId) => VOICE_WEIGHT[byCell.get(`${vendorId}|${claimId}`)?.intensity ?? ""] ?? 0),
  );
  const means = claimIds.map((_, j) => matrix.reduce((sum, row) => sum + row[j], 0) / vendors.length);
  const centered = matrix.map((row) => row.map((value, j) => value - means[j]));

  const component = (deflate?: number[]): { loadings: number[]; scores: number[] } => {
    let v = new Array<number>(claimIds.length).fill(1 / Math.sqrt(claimIds.length));
    for (let iteration = 0; iteration < 300; iteration += 1) {
      if (deflate) {
        const dot = v.reduce((sum, x, k) => sum + x * deflate[k], 0);
        v = v.map((x, k) => x - dot * deflate[k]);
      }
      const scores = centered.map((row) => row.reduce((sum, x, j) => sum + x * v[j], 0));
      v = claimIds.map((_, j) => centered.reduce((sum, row, i) => sum + row[j] * scores[i], 0));
      const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
      v = v.map((x) => x / norm);
    }
    return { loadings: v, scores: centered.map((row) => row.reduce((sum, x, j) => sum + x * v[j], 0)) };
  };

  const first = component();
  const second = component(first.loadings);
  const shape = (raw: { loadings: number[]; scores: number[] }): PrincipalComponent => ({
    loadings: claimIds.map((claimId, j) => ({ claimId, loading: raw.loadings[j] })),
    scores: vendors.map((vendorId, i) => ({ vendorId, score: raw.scores[i] })),
  });
  return { vendors, pc1: shape(first), pc2: shape(second) };
}

// ---------------------------------------------------------------------------
// The axes report: positions, triangulation vs PCA, orthogonality screen.

export type AxisVendorPosition = { vendorId: string; position: number | null };

export type AxisAssessment = {
  axis: MarketAxis;
  positions: AxisVendorPosition[];
  /** Standard deviation of placeable vendor positions — does the axis separate anyone? */
  spread: number;
  rVsPc1: number;
  rVsPc2: number;
};

export type AxisPairing = {
  aId: string;
  bId: string;
  r: number;
  verdict: "near-orthogonal" | "correlated — weak pair" | "redundant — same axis twice";
};

export type AxesReport = {
  vendors: string[];
  pc1: PrincipalComponent;
  pc2: PrincipalComponent;
  assessments: AxisAssessment[];
  /** Includes the derived breadth axis in pairings. */
  pairings: AxisPairing[];
};

export function pairingVerdict(r: number): AxisPairing["verdict"] {
  const magnitude = Math.abs(r);
  if (magnitude < 0.4) return "near-orthogonal";
  if (magnitude < 0.75) return "correlated — weak pair";
  return "redundant — same axis twice";
}

export function assessAxes(config: MarketConfig, set: ObservationSet): AxesReport {
  const { vendors, pc1, pc2 } = pcaTop2(config, set);
  const pcScore = (pc: PrincipalComponent) => new Map(pc.scores.map((entry) => [entry.vendorId, entry.score]));
  const pc1ByVendor = pcScore(pc1);
  const pc2ByVendor = pcScore(pc2);

  const axes = config.axes ?? [];
  const positionsById = new Map<string, Map<string, number>>();
  const assessments: AxisAssessment[] = axes.map((axis) => {
    const positions: AxisVendorPosition[] = vendors.map((vendorId) => ({
      vendorId,
      position: axisPosition(vendorId, axis.claimScores, set.observations),
    }));
    const placeable = positions.filter((entry): entry is { vendorId: string; position: number } => entry.position !== null);
    positionsById.set(axis.id, new Map(placeable.map((entry) => [entry.vendorId, entry.position])));
    const values = placeable.map((entry) => entry.position);
    const mean = values.reduce((sum, x) => sum + x, 0) / Math.max(values.length, 1);
    const spread = Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(values.length, 1));
    const aligned = placeable.filter((entry) => pc1ByVendor.has(entry.vendorId));
    return {
      axis,
      positions,
      spread,
      rVsPc1: pearson(aligned.map((entry) => entry.position), aligned.map((entry) => pc1ByVendor.get(entry.vendorId) as number)),
      rVsPc2: pearson(aligned.map((entry) => entry.position), aligned.map((entry) => pc2ByVendor.get(entry.vendorId) as number)),
    };
  });

  // Derived breadth axis joins the orthogonality screen (it's free and often
  // the only near-orthogonal partner early on).
  const breadthPositions = new Map<string, number>();
  for (const vendorId of vendors) {
    const { breadth } = messageBreadth(vendorId, set.observations);
    if (breadth !== null) breadthPositions.set(vendorId, breadth);
  }
  positionsById.set("breadth", breadthPositions);

  const ids = [...axes.map((axis) => axis.id), "breadth"];
  const pairings: AxisPairing[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = positionsById.get(ids[i]) as Map<string, number>;
      const b = positionsById.get(ids[j]) as Map<string, number>;
      const shared = vendors.filter((vendorId) => a.has(vendorId) && b.has(vendorId));
      const r = pearson(shared.map((vendorId) => a.get(vendorId) as number), shared.map((vendorId) => b.get(vendorId) as number));
      pairings.push({ aId: ids[i], bId: ids[j], r, verdict: pairingVerdict(r) });
    }
  }

  return { vendors, pc1, pc2, assessments, pairings };
}

export function axesReportToText(report: AxesReport): string {
  const lines: string[] = [];
  for (const [label, pc] of [
    ["PC1", report.pc1],
    ["PC2", report.pc2],
  ] as const) {
    lines.push(`=== ${label} — claim loadings (extremes; sign is arbitrary, read the poles) ===`);
    const ordered = [...pc.loadings].sort((a, b) => a.loading - b.loading);
    for (const entry of ordered.slice(0, 5)) {
      lines.push(`  ${entry.loading >= 0 ? "+" : ""}${entry.loading.toFixed(2)}  ${entry.claimId}`);
    }
    lines.push("   ...");
    for (const entry of ordered.slice(-5)) {
      lines.push(`  ${entry.loading >= 0 ? "+" : ""}${entry.loading.toFixed(2)}  ${entry.claimId}`);
    }
    lines.push(
      `  vendor scores: ${[...pc.scores]
        .sort((a, b) => a.score - b.score)
        .map((entry) => `${entry.vendorId}=${entry.score >= 0 ? "+" : ""}${entry.score.toFixed(2)}`)
        .join("  ")}`,
    );
    lines.push("");
  }
  if (report.assessments.length > 0) {
    lines.push("=== configured axes vs PCA (triangulation: a real axis is derivable from the data) ===");
    for (const assessment of report.assessments) {
      lines.push(
        `  ${assessment.axis.id.padEnd(20)} spread=${assessment.spread.toFixed(3)}  r(PC1)=${assessment.rVsPc1 >= 0 ? "+" : ""}${assessment.rVsPc1.toFixed(2)}  r(PC2)=${assessment.rVsPc2 >= 0 ? "+" : ""}${assessment.rVsPc2.toFixed(2)}  [${assessment.axis.status ?? ""}]`,
      );
    }
    lines.push("");
    lines.push("=== orthogonality screen (|r|>0.75 = redundant pair) ===");
    for (const pairing of report.pairings) {
      const flag = pairing.verdict === "redundant — same axis twice" ? "  <-- redundant" : "";
      lines.push(
        `  ${pairing.aId.padEnd(18)} x ${pairing.bId.padEnd(18)} r=${pairing.r >= 0 ? "+" : ""}${pairing.r.toFixed(2)}${flag}`,
      );
    }
  } else {
    lines.push("No axes configured. Read the PC loadings above, name the two directions, and add them");
    lines.push("to market.config.json as axes: [{ id, label, negativePole, positivePole, rubric, claimScores }].");
  }
  return `${lines.join("\n")}\n`;
}
