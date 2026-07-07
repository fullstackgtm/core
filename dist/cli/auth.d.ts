/**
 * The broker channel carries a long-lived pairing bearer and receives freshly
 * minted live-CRM tokens, so it must be TLS unless it's an explicit localhost
 * dev target. Refuse http:// (and non-http schemes) otherwise — single-quote
 * shell escaping does nothing for a token sent in cleartext.
 */
export declare function assertSecureBrokerUrl(raw: string): URL;
type CrmProvider = "hubspot" | "salesforce";
export declare function hostedProviderLogin(provider: CrmProvider, baseUrl: string): Promise<void>;
export declare function login(args: string[]): Promise<void>;
export declare function logout(args: string[]): void;
type ProviderDoctorStatus = {
    source: "env" | "stored" | "broker" | "none";
    detail: string;
};
export declare function doctorReport(env?: Record<string, string | undefined>): {
    package: {
        name: string;
        version: string;
    };
    node: {
        version: string;
        ok: boolean;
        required: string;
    };
    profile: string;
    credentialStore: {
        path: string;
        exists: boolean;
    };
    config: {
        path: string;
        exists: boolean;
    };
    providers: Record<string, ProviderDoctorStatus>;
    broker: {
        paired: boolean;
        baseUrl: string;
    } | {
        paired: boolean;
        baseUrl?: undefined;
    };
    llm: {
        configured: boolean;
        provider: import("../llm.ts").LlmProvider;
        source: "stored" | "env";
        detail?: undefined;
    } | {
        configured: boolean;
        detail: string;
        provider?: undefined;
        source?: undefined;
    };
    mcp: {
        peersInstalled: boolean;
        missing: string[];
    };
    nextSteps: string[];
};
export type WorkspaceDoctor = {
    profile: string;
    healthScore: number | null;
    scoreDelta: number | null;
    lastAuditAt: string | null;
    auditCount: number;
    pendingPlans: Array<{
        id: string;
        summary: string;
        operations: number;
        approved: number;
    }>;
};
/**
 * The workspace slice of doctor: current health + plans awaiting approval.
 * Folded into doctor (rather than adding a separate triage verb) so a single
 * call returns environment + workspace state + copy-pasteable next commands —
 * previously an agent needed three round-trips (doctor, health, plans list)
 * to orient itself.
 */
export declare function workspaceDoctor(): Promise<WorkspaceDoctor>;
export declare function doctorCommand(args: string[]): Promise<void>;
export {};
