declare module "pdf-parse" {
  interface PDFData {
    numpages: number;
    text: string;
  }
  const pdf: (dataBuffer: Buffer, options?: Record<string, unknown>) => Promise<PDFData>;
  export default pdf;
}
