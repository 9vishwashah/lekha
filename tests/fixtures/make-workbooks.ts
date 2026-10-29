import ExcelJS from "exceljs";

/**
 * Builds workbooks shaped like the two supplied spreadsheets (the originals were not available in
 * the project, so these reproduce the layouts described in the brief): a title row, extra sheets,
 * blank rows, mixed date formats (real dates, Excel serials, DD/MM/YYYY text), missing serial
 * numbers, a running-balance column with formulas, and total lines at the bottom.
 */
export async function basicWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const notes = wb.addWorksheet("Notes");
  notes.addRow(["Ramesh Saini – site account"]);
  const ws = wb.addWorksheet("Transactions");
  ws.addRow(["RAMESH SAINI TRANSACTION RECORD"]);
  ws.addRow([]);
  ws.addRow(["SR. NO.", "DATE", "PAYEE", "CREDIT", "DEBIT", "BALANCE"]);
  ws.addRow([1, new Date(Date.UTC(2026, 3, 1)), "Opening cash from owner", 50000, null, { formula: "D4-E4", result: 50000 }]);
  ws.addRow([2, 46115, "Cement 20 bags", null, 8400, { formula: "F4+D5-E5", result: 41600 }]); // Excel serial for 03/04/2026
  ws.addRow([null, "05/04/2026", "Labour – week 1", null, "12,500.00", { formula: "F5+D6-E6", result: 29100 }]);
  ws.addRow([]);
  ws.addRow([4, "06-Apr-26", "Refund from supplier", 1200, null, { formula: "F6+D8-E8", result: 30300 }]);
  ws.addRow([5, "6/4/2026", "Refund from supplier", 1200, null, { formula: "F8+D9-E9", result: 31500 }]); // duplicate-looking
  ws.addRow([6, "31/02/2026", "Bad date row", null, 100, null]);
  ws.addRow([7, "07/04/2026", "Both columns", 10, 20, null]);
  ws.addRow([null, null, "TOTAL", 52400, 21000, null]);
  ws.addRow([null, null, null, null, null, 31500]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function taxationWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["DATE", "NAME", "CREDIT", "DEBIT", "BILL AMT", "GST", "TDS", "AFTER TDS"]);
  ws.addRow([new Date(Date.UTC(2026, 3, 10)), "Rishabh Sales & Creative", null, null, 1000000, 180000, 10000, 1170000]);
  ws.addRow([new Date(Date.UTC(2026, 3, 20)), "Rishabh Sales & Creative", null, 500000, null, null, null, null]);
  ws.addRow([new Date(Date.UTC(2026, 4, 2)), "GST paid to Government", null, 180000, null, null, null, null]);
  ws.addRow([new Date(Date.UTC(2026, 4, 5)), "Rishabh – May bill", null, null, 200000, 36000, 2000, 235000]); // sheet net is wrong (234000)
  ws.addRow([null, "TOTAL", null, 680000, 1200000, 216000, 12000, 1405000]);
  const extra = wb.addWorksheet("Summary");
  extra.addRow(["Total bills", 1200000]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
