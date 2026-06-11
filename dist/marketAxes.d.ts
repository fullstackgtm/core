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
export declare const VOICE_WEIGHT: Record<string, number>;
/**
 * Intensity-weighted mean of claim scores over claims the vendor voices.
 * Claims scored null on the axis are excluded; returns null if the vendor
 * voices nothing scoreable (e.g. fully unobservable).
 */
export declare function axisPosition(vendorId: string, claimScores: Record<string, number | null>, observations: MarketObservation[]): number | null;
/** Share of the claim space voiced (loud + half-weight quiet) over observable claims. */
export declare function messageBreadth(vendorId: string, observations: MarketObservation[]): {
    breadth: number | null;
    loudCount: number;
};
export declare function pearson(xs: number[], ys: number[]): number;
export type PrincipalComponent = {
    /** claimId → loading. Sign is arbitrary; read poles from the extremes. */
    loadings: Array<{
        claimId: string;
        loading: number;
    }>;
    /** vendorId → score on this component. */
    scores: Array<{
        vendorId: string;
        score: number;
    }>;
};
export declare function pcaTop2(config: MarketConfig, set: ObservationSet): {
    vendors: string[];
    pc1: PrincipalComponent;
    pc2: PrincipalComponent;
};
export type AxisVendorPosition = {
    vendorId: string;
    position: number | null;
};
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
export declare function pairingVerdict(r: number): AxisPairing["verdict"];
export declare function assessAxes(config: MarketConfig, set: ObservationSet): AxesReport;
export declare function axesReportToText(report: AxesReport): string;
