import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fchmodSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync, readFileSync, } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
export class UnsafeManagedPathError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnsafeManagedPathError";
    }
}
export function assertNoSymlinkComponents(path) {
    const absolute = isAbsolute(path) ? path : resolve(path);
    const root = parse(absolute).root;
    const relative = absolute.slice(root.length);
    let current = root;
    for (const component of relative.split(/[\\/]+/).filter(Boolean)) {
        current = resolve(current, component);
        let stat;
        try {
            stat = lstatSync(current);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new UnsafeManagedPathError(`Refusing to use unsafe path containing a symbolic link: ${current}`);
        }
    }
}
/** Read a managed file through a no-follow descriptor and require a regular file. */
export function readSecureRegularFile(path, options = {}) {
    const absolute = resolve(path);
    assertNoSymlinkComponents(dirname(absolute));
    try {
        if (lstatSync(absolute).isSymbolicLink()) {
            throw new UnsafeManagedPathError(`Refusing to read symbolic link: ${absolute}`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let fd;
    try {
        fd = openSync(absolute, constants.O_RDONLY | noFollow);
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            throw new UnsafeManagedPathError(`Refusing to read non-regular file: ${absolute}`);
        }
        if (options.tightenMode !== undefined) {
            const previousMode = stat.mode & 0o777;
            if ((previousMode & ~options.tightenMode) !== 0) {
                try {
                    fchmodSync(fd, options.tightenMode);
                    options.onModeTightened?.(previousMode);
                }
                catch {
                    // Windows and some non-POSIX filesystems do not implement chmod.
                }
            }
        }
        return readFileSync(fd, "utf8");
    }
    catch (error) {
        if (error.code === "ELOOP") {
            throw new UnsafeManagedPathError(`Refusing to read symbolic link: ${absolute}`);
        }
        throw error;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/**
 * Atomically replace a private file without ever opening the destination.
 * Existing destination and parent symlinks are rejected. The temporary file
 * is created exclusively beside the destination so rename remains atomic.
 */
export function writeSecureFileAtomic(path, contents) {
    const destination = resolve(path);
    const parent = dirname(destination);
    assertNoSymlinkComponents(parent);
    try {
        if (lstatSync(destination).isSymbolicLink()) {
            throw new Error(`Refusing to replace symbolic link: ${destination}`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    let temporary = "";
    let fd;
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
            try {
                const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
                fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
                break;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
        }
        if (fd === undefined)
            throw new Error(`Unable to create an exclusive temporary file for ${destination}`);
        writeFileSync(fd, contents);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        try {
            chmodSync(temporary, 0o600);
        }
        catch {
            // Windows and some non-POSIX filesystems do not implement chmod.
        }
        // Recheck immediately before replacement. rename replaces a symlink rather
        // than following it, but rejecting one makes managed-path policy explicit.
        try {
            if (lstatSync(destination).isSymbolicLink()) {
                throw new Error(`Refusing to replace symbolic link: ${destination}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        assertNoSymlinkComponents(parent);
        renameSync(temporary, destination);
        temporary = "";
        // Persist the directory entry where supported. Opening/fsyncing a
        // directory is not available on Windows, so this durability enhancement is
        // deliberately best-effort there.
        let directoryFd;
        try {
            directoryFd = openSync(parent, constants.O_RDONLY);
            fsyncSync(directoryFd);
        }
        catch {
            // Unsupported by the platform/filesystem.
        }
        finally {
            if (directoryFd !== undefined)
                closeSync(directoryFd);
        }
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        if (temporary) {
            try {
                unlinkSync(temporary);
            }
            catch {
                // Best-effort cleanup after a failed write.
            }
        }
    }
}
