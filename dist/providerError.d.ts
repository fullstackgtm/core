/**
 * A persistence-safe provider failure. Third-party response bodies are
 * deliberately excluded: they can reflect credentials, filters, or PII and
 * errors are rendered in terminals, MCP responses, and scheduled-run files.
 */
export declare class ProviderHttpError extends Error {
    readonly code = "PROVIDER_HTTP_ERROR";
    readonly provider: string;
    readonly operation: string;
    readonly status: number;
    readonly retryable: boolean;
    constructor(provider: string, operation: string, status: number, retryable?: boolean);
    toJSON(): {
        code: string;
        provider: string;
        operation: string;
        status: number;
        retryable: boolean;
        message: string;
    };
}
