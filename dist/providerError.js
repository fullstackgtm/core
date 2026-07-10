/**
 * A persistence-safe provider failure. Third-party response bodies are
 * deliberately excluded: they can reflect credentials, filters, or PII and
 * errors are rendered in terminals, MCP responses, and scheduled-run files.
 */
export class ProviderHttpError extends Error {
    code = "PROVIDER_HTTP_ERROR";
    provider;
    operation;
    status;
    retryable;
    constructor(provider, operation, status, retryable = status === 429 || status >= 500) {
        super(`${provider} ${operation} failed: HTTP ${status}.`);
        this.name = "ProviderHttpError";
        this.provider = provider;
        this.operation = operation;
        this.status = status;
        this.retryable = retryable;
    }
    toJSON() {
        return {
            code: this.code,
            provider: this.provider,
            operation: this.operation,
            status: this.status,
            retryable: this.retryable,
            message: this.message,
        };
    }
}
