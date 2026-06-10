export type CrmObjectType = "owners" | "accounts" | "contacts" | "deals";
export type FieldMappings = Partial<Record<CrmObjectType | string, Record<string, string>>>;
export declare const HUBSPOT_DEFAULT_FIELD_MAPPINGS: Record<Exclude<CrmObjectType, "owners">, Record<string, string>>;
export declare const SALESFORCE_DEFAULT_FIELD_MAPPINGS: Record<CrmObjectType, Record<string, string>>;
export declare function normalizeFieldMappings(value: unknown): FieldMappings;
export declare function mappedField(mappings: FieldMappings | undefined, objectType: CrmObjectType, targetField: string, fallbackField: string): string;
export declare function mappedFields(mappings: FieldMappings | undefined, objectType: CrmObjectType, defaults: Record<string, string>): string[];
export declare function readMappedValue(source: Record<string, unknown>, mappings: FieldMappings | undefined, objectType: CrmObjectType, targetField: string, fallbackField: string): unknown;
