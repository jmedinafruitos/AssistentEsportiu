// @types/pdf-parse only covers the package root ("pdf-parse"). We import the
// internal lib module directly (see extraction.ts) to skip a debug block in
// the root index.js, so it needs its own ambient declaration — same shape
// as @types/pdf-parse.
declare module "pdf-parse/lib/pdf-parse.js" {
  function pdfParse(dataBuffer: Buffer, options?: pdfParse.Options): Promise<pdfParse.Result>;
  namespace pdfParse {
    interface Result {
      numpages: number;
      numrender: number;
      info: unknown;
      metadata: unknown;
      version: string;
      text: string;
    }
    interface Options {
      pagerender?: ((pageData: unknown) => string | Promise<string>) | undefined;
      max?: number | undefined;
      version?: string | undefined;
    }
  }
  export = pdfParse;
}
