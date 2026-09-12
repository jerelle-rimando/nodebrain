declare module 'mammoth' {
  export interface ExtractRawTextInput {
    path?: string;
    buffer?: Buffer;
  }

  export interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }

  export function extractRawText(input: ExtractRawTextInput): Promise<ExtractRawTextResult>;
}
