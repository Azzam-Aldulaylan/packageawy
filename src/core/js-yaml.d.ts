declare module 'js-yaml' {
  export class YAMLException extends Error {}
  export interface LoadOptions {
    filename?: string;
    json?: boolean;
    schema?: unknown;
  }

  export function load(input: string, options?: LoadOptions): unknown;
}
