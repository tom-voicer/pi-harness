/**
 * Stdout guard — stores a reference to the real stdout.write so tree
 * rendering can always write directly, while SDK internals get suppressed
 * during session.prompt().
 */

const rawWrite = process.stdout.write.bind(process.stdout);

/** Write directly to the real stdout, bypassing any replacement on process.stdout.write. */
export function writeStdout(data: string): void {
  rawWrite(data);
}

let guarding = false;

/** Replace process.stdout.write with a no-op to suppress SDK leakage. */
export function guardStdout(): void {
  if (guarding) return;
  process.stdout.write = ((_chunk: any, _enc?: any, cb?: any) => {
    if (typeof cb === "function") cb();
    return true;
  }) as any;
  guarding = true;
}

/** Restore process.stdout.write to the real function. */
export function releaseStdout(): void {
  if (!guarding) return;
  process.stdout.write = rawWrite;
  guarding = false;
}
