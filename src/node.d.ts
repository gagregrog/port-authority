// The Node APIs the worker uses; the plugin typings do not include @types/node.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: string[],
    options: { timeout?: number; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}

declare const process: { env: Record<string, string | undefined>; getuid?: () => number }

declare module 'node:fs' {
  export function existsSync(path: string): boolean
}
