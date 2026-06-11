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
    mcp: {
        peersInstalled: boolean;
        missing: string[];
    };
    nextSteps: string[];
};
export declare function runCli(argv: string[]): Promise<void>;
export {};
