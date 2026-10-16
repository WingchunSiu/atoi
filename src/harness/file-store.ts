import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** One local filesystem, one controller. No shared-NFS or multi-host locking claim. */
export async function atomicJson(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}

export async function loadJson(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function lockController(root: string) {
  await mkdir(root, { recursive: true });
  const lock = path.join(root, "controller-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Controller lock exists at ${lock}; inspect the old process before removing it`,
    );
  }
  await atomicJson(path.join(lock, "owner.json"), {
    pid: process.pid,
    started: new Date().toISOString(),
  });
  return () => rm(lock, { recursive: true });
}
