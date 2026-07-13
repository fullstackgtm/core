import { type Icp } from "../icp.ts";
export type WebsiteIcpEvidence = {
    label: string;
    excerpt: string;
    sourceUrl: string;
};
export type WebsiteIcpDerivation = {
    company: {
        name: string;
        domain: string;
        summary: string;
    };
    icp: Icp;
    evidence: WebsiteIcpEvidence[];
    confidence: number;
    derivation: {
        mode: "model";
        model: string;
    };
};
export declare const WEBSITE_ICP_DERIVE_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["companyName", "summary", "motion", "investmentStages", "fundingAmounts", "thesisKeywords", "industries", "employeeBands", "geos", "technologies", "jobLevels", "departments", "titleKeywords", "intentTopics", "triggerHypotheses", "confidence", "traceSummary", "evidence"];
    readonly properties: {
        readonly companyName: {
            readonly type: "string";
        };
        readonly summary: {
            readonly type: "string";
        };
        readonly motion: {
            readonly type: "string";
            readonly enum: readonly ["sales", "investment"];
            readonly description: "Use investment for VC, PE, accelerators, and funds sourcing companies to invest in.";
        };
        readonly investmentStages: {
            readonly type: "array";
            readonly description: "Stages of TARGET COMPANIES when this fund invests. Never infer later stages from the fund's own fund number, AUM, or portfolio companies' current maturity.";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["pre-seed", "seed", "series-a", "series-b", "growth", "bootstrapped"];
            };
        };
        readonly fundingAmounts: {
            readonly type: "array";
            readonly description: "TOTAL FUNDING ALREADY RAISED BY TARGET COMPANIES before this investment. This is not fund size, AUM, check size, or capital deployed. A fund being $250M must never produce 100m_250m here. Use unknown when the website does not support a target-company range.";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["under_1m", "1m_5m", "5m_10m", "10m_25m", "25m_50m", "50m_100m", "100m_250m", "over_250m", "unknown"];
            };
        };
        readonly thesisKeywords: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Concrete keywords expected in an investment target company's description.";
        };
        readonly industries: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly employeeBands: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
            };
        };
        readonly geos: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly technologies: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly jobLevels: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["cxo", "vp", "director", "head", "manager", "owner", "founder", "senior"];
            };
        };
        readonly departments: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly titleKeywords: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly intentTopics: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly triggerHypotheses: {
            readonly type: "array";
            readonly maxItems: 5;
            readonly description: "Observable, testable public behaviors that indicate timing or pain at a target account. Prefer concrete projects, operating changes, and role responsibilities over demographics.";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["id", "label", "positiveEvidence", "activeProjects", "buyerFunctions", "negativeEvidence", "preferredSources"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly label: {
                        readonly type: "string";
                    };
                    readonly positiveEvidence: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly activeProjects: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly buyerFunctions: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly negativeEvidence: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly preferredSources: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly enum: readonly ["job", "news", "company", "social", "review", "legal"];
                        };
                    };
                };
            };
        };
        readonly confidence: {
            readonly type: "number";
        };
        readonly traceSummary: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "2-5 concise, user-facing observations that explain which offer, account, and buyer signals drove the ICP. Do not reveal hidden chain-of-thought.";
        };
        readonly evidence: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["label", "quote", "source"];
                readonly properties: {
                    readonly label: {
                        readonly type: "string";
                    };
                    readonly quote: {
                        readonly type: "string";
                    };
                    readonly source: {
                        readonly type: "string";
                        readonly enum: readonly ["homepage", "llms"];
                    };
                };
            };
        };
    };
};
export declare function buildWebsiteIcpPrompt(args: {
    domain: string;
    homepageText: string;
    llmsText: string;
}): string;
export declare function normalizeWebsiteIcpModelResult(args: {
    domain: string;
    homepageText: string;
    homepageUrl: string;
    llmsText: string;
    llmsUrl: string;
    raw: Record<string, unknown>;
    model: string;
}): WebsiteIcpDerivation;
export declare function websiteIcpTraceSummaries(raw: Record<string, unknown>): string[];
