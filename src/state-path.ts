import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { SecurityError } from "./security.js";

function assertOwnerOnly(metadata: Awaited<ReturnType<typeof lstat>>, kind: string): void {
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SecurityError("POLICY_DENIED", `${kind} is not owned by the current user`);
  }
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new SecurityError("POLICY_DENIED", `${kind} permissions are not owner-only`);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SecurityError("POLICY_DENIED", "State directory is a symlink or non-directory");
  }
  assertOwnerOnly(metadata, "State directory");
}

/** Creates and validates the dedicated private directory that owns durable state. */
export async function assertPrivateStatePath(statePath: string): Promise<void> {
  if (!isAbsolute(statePath)) {
    throw new SecurityError("POLICY_DENIED", "State path must be absolute");
  }
  const directory = dirname(resolve(statePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  await assertPrivateDirectory(directory);

  try {
    const metadata = await lstat(statePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new SecurityError("POLICY_DENIED", "State path is a symlink or non-regular file");
    }
    assertOwnerOnly(metadata, "State file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
