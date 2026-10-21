export type Io = {
  cwd: string
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
  stdin?: NodeJS.ReadableStream
  now?: () => Date
}

export class UsageError extends Error {}
