declare module 'ini' {
  export function parse(text: string): Record<string, unknown>;
}
