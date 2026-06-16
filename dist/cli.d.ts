import { type LlmProvider } from "./llm.ts";
/**
 * The broker channel carries a long-lived pairing bearer and receives freshly
 * minted live-CRM tokens, so it must be TLS unless it's an explicit localhost
 * dev target. Refuse http:// (and non-http schemes) otherwise — single-quote
 * shell escaping does nothing for a token sent in cleartext.
 */
export declare function assertSecureBrokerUrl(raw: string): URL;
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
        provider: LlmProvider;
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
export declare function runCli(argv: string[]): Promise<void>;
export {};
