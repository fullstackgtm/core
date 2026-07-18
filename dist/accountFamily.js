function rawString(account, keys) {
    if (!account.raw || typeof account.raw !== "object")
        return undefined;
    const raw = account.raw;
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (value && typeof value === "object") {
            const nested = value;
            for (const nestedKey of ["id", "value", "name"]) {
                if (typeof nested[nestedKey] === "string" && String(nested[nestedKey]).trim())
                    return String(nested[nestedKey]).trim();
            }
        }
    }
    return undefined;
}
export function accountParentId(account) {
    return account.parentAccountId ?? rawString(account, ["parentAccountId", "parent_account_id", "ParentId", "parentCompanyId", "hs_parent_company_id"]);
}
/** A recorded family relationship is a merge blocker, never duplicate proof. */
export function accountsShareKnownFamily(accounts) {
    const ids = new Set(accounts.map((account) => String(account.id)));
    const parents = accounts.map(accountParentId).filter((value) => Boolean(value));
    if (parents.some((parentId) => ids.has(parentId)))
        return true;
    return new Set(parents).size === 1 && parents.length > 1;
}
