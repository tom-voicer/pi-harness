/**
 * Stdout/stderr guard — stores references to the real write functions so tree
 * rendering can always write directly, while SDK leakage gets suppressed
 * during session.prompt(). Critical because any terminal output (even stderr)
 * shifts the cursor and breaks log-update's diff-based cursor tracking.
 */

const rawWrite = process.stdout.write.bind(process.stdout);
const rawStderrWrite = process.stderr.write.bind(process.stderr);

/** The raw stdout write function, captured before any replacement. */
export { rawWrite };

/** Write directly to the real stdout, bypassing any replacement on process.stdout.write. */
export function writeStdout(data: string): void {
  rawWrite(data);
}

let guarding = false;

/** Replace process.stdout.write AND process.stderr.write with no-ops to suppress SDK leakage. */
export function guardStdout(): void {
  if (guarding) return;
  const noop = ((_chunk: any, _enc?: any, cb?: any) => {
    if (typeof cb === "function") cb();
    return true;
  }) as any;
  process.stdout.write = noop;
  process.stderr.write = noop;
  guarding = true;
}

/** Restore process.stdout.write and process.stderr.write to the real functions. */
export function releaseStdout(): void {
  if (!guarding) return;
  process.stdout.write = rawWrite;
  process.stderr.write = rawStderrWrite;
  guarding = false;
}
