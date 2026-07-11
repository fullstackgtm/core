import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir } from "./credentials.js";
import { assertNoSymlinkComponents, readSecureRegularFile, writeSecureFileAtomic, } from "./secureFile.js";
const COMPONENT_MAX = 512;
function requireComponent(value, name) {
    if (typeof value !== "string" || value.length === 0 || value.length > COMPONENT_MAX || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`Invalid acquisition checkpoint ${name}`);
    }
    return value;
}
export function validateAcquireCheckpointKey(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid acquisition checkpoint key");
    }
    const candidate = value;
    const listId = candidate.listId;
    if (listId !== null && listId !== undefined)
        requireComponent(listId, "listId");
    return {
        provider: requireComponent(candidate.provider, "provider"),
        source: requireComponent(candidate.source, "source"),
        listId: listId ?? null,
        queryFingerprint: requireComponent(candidate.queryFingerprint, "queryFingerprint"),
    };
}
/** Stable, non-secret filename/key suitable for both filesystem and hosted records. */
export function acquireCheckpointId(key) {
    const valid = validateAcquireCheckpointKey(key);
    const canonical = JSON.stringify([valid.provider, valid.source, valid.listId, valid.queryFingerprint]);
    return `acqcp_${createHash("sha256").update(canonical).digest("hex")}`;
}
function validateContinuation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid acquisition checkpoint continuation");
    }
    const candidate = value;
    if (typeof candidate.exhausted !== "boolean")
        throw new Error("Invalid acquisition checkpoint exhausted flag");
    if (candidate.cursor !== undefined && candidate.cursor !== null)
        requireComponent(candidate.cursor, "cursor");
    if (candidate.offset !== undefined && candidate.offset !== null &&
        (!Number.isSafeInteger(candidate.offset) || candidate.offset < 0)) {
        throw new Error("Invalid acquisition checkpoint offset");
    }
    return {
        ...(candidate.cursor !== undefined ? { cursor: candidate.cursor } : {}),
        ...(candidate.offset !== undefined ? { offset: candidate.offset } : {}),
        exhausted: candidate.exhausted,
    };
}
export function validateAcquireCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid acquisition checkpoint");
    }
    const candidate = value;
    if (candidate.version !== 1)
        throw new Error(`Unsupported acquisition checkpoint version: ${String(candidate.version)}`);
    const key = validateAcquireCheckpointKey(candidate.key);
    const id = acquireCheckpointId(key);
    if (candidate.id !== id)
        throw new Error("Acquisition checkpoint id does not match its key");
    if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) {
        throw new Error("Invalid acquisition checkpoint updatedAt");
    }
    return {
        version: 1,
        id,
        key,
        continuation: validateContinuation(candidate.continuation),
        updatedAt: candidate.updatedAt,
    };
}
export function acquireCheckpointsDir(baseDir) {
    return join(baseDir ?? credentialsDir(), "acquire", "checkpoints");
}
export function createFileAcquireCheckpointStore(baseDir) {
    const directory = acquireCheckpointsDir(baseDir);
    function fileForId(id) {
        return join(directory, `${id}.json`);
    }
    function readId(id) {
        try {
            return validateAcquireCheckpoint(JSON.parse(readSecureRegularFile(fileForId(id), { tightenMode: 0o600 })));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    function ensureDirectory() {
        if (baseDir === undefined)
            ensureSecureHomeDir();
        // Tighten both managed levels. mkdir's mode does not affect a directory
        // restored or pre-created with broader permissions.
        const levels = [join(baseDir ?? credentialsDir(), "acquire"), directory];
        for (const level of levels) {
            assertNoSymlinkComponents(level);
            mkdirSync(level, { recursive: true, mode: 0o700 });
            assertNoSymlinkComponents(level);
            try {
                chmodSync(level, 0o700);
            }
            catch { /* chmod is unavailable on some filesystems. */ }
        }
    }
    function writeRecord(value) {
        const record = validateAcquireCheckpoint(value);
        ensureDirectory();
        writeSecureFileAtomic(fileForId(record.id), `${JSON.stringify(record, null, 2)}\n`);
        return record;
    }
    return {
        async get(key) {
            return readId(acquireCheckpointId(key));
        },
        async put(key, continuation, updatedAt = new Date()) {
            const validKey = validateAcquireCheckpointKey(key);
            return writeRecord({
                version: 1,
                id: acquireCheckpointId(validKey),
                key: validKey,
                continuation: validateContinuation(continuation),
                updatedAt: updatedAt.toISOString(),
            });
        },
        async putRecord(record) {
            return writeRecord(record);
        },
        async list() {
            let names;
            try {
                assertNoSymlinkComponents(directory);
                names = readdirSync(directory).filter((name) => /^acqcp_[a-f0-9]{64}\.json$/.test(name));
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return [];
                throw error;
            }
            return names
                .map((name) => readId(name.slice(0, -5)))
                .filter((record) => record !== null)
                .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        },
    };
}
