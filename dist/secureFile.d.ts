export declare class UnsafeManagedPathError extends Error {
    constructor(message: string);
}
export declare function assertNoSymlinkComponents(path: string): void;
/** Read a managed file through a no-follow descriptor and require a regular file. */
export declare function readSecureRegularFile(path: string, options?: {
    tightenMode?: number;
    onModeTightened?: (previousMode: number) => void;
}): string;
/**
 * Atomically replace a private file without ever opening the destination.
 * Existing destination and parent symlinks are rejected. The temporary file
 * is created exclusively beside the destination so rename remains atomic.
 */
export declare function writeSecureFileAtomic(path: string, contents: string | Uint8Array): void;
