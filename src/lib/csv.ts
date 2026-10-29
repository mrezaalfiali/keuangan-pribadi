export function toCsv(rows: string[][]): string {
  const escapeCell = (value: string) => {
    if (value.includes("\"") || value.includes(",") || value.includes("\n") || value.includes("\r")) {
      return `"${value.replace(/"/g, "\"\"")}"`;
    }
    return value;
  };
  return rows.map((row) => row.map((cell) => escapeCell(cell ?? "")).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
