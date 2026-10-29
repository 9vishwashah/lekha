import "server-only";
import { type ReportTable, safeFileName, toCSV } from "./table";
import { toXLSX } from "./xlsx";
import { toPDF } from "./pdf";
import { formatDateTime } from "@/lib/domain/dates";

export type ExportFormat = "xlsx" | "csv" | "pdf";

export const parseFormat = (v: string | null): ExportFormat | null => (v === "xlsx" || v === "csv" || v === "pdf" ? v : null);

/** Renders report tables in the requested format as a private, non-cacheable download. */
export async function exportResponse(tables: ReportTable[], format: ExportFormat, meta: { business: string; fileName: string }) {
  const name = safeFileName(meta.fileName);
  const headers: Record<string, string> = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "csv") {
    return new Response(toCSV(tables[0]), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` },
    });
  }
  if (format === "xlsx") {
    const body = await toXLSX(tables, { creator: meta.business });
    return new Response(new Uint8Array(body), {
      headers: {
        ...headers,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
      },
    });
  }
  const pdf = await toPDF(tables[0], { business: meta.business, generatedAt: formatDateTime(new Date()) });
  return new Response(new Uint8Array(pdf), {
    headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"` },
  });
}
