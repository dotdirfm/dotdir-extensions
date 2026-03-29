import React, { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Database, SqlJsStatic } from "sql.js";
import initSqlJs from "sql.js";
// @ts-expect-error - Vite ?url
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { EditorProps } from "@dotdirfm/extension-api";

type QueryResult =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | {
      kind: "table";
      columns: string[];
      rows: Array<Array<string | number | null>>;
      rowCount: number;
    }
  | { kind: "no_rows"; columns: string[] };

const DEFAULT_QUERY = `-- Read-only example
SELECT name, type
FROM sqlite_master
WHERE type IN ('table','view')
ORDER BY type, name;`;

function fmtVal(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return `blob(${v.byteLength})`;
  return String(v);
}

function isLikelyMutating(sql: string): boolean {
  const s = sql.trim().toLowerCase();
  // allow "with ... select" too
  if (s.startsWith("select") || s.startsWith("with") || s.startsWith("pragma"))
    return false;
  return true;
}

function useStyles() {
  return useMemo(() => {
    const container: React.CSSProperties = {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily:
        "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      background: "var(--bg)",
      color: "var(--fg)",
    };

    const topbar: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      padding: "10px 12px",
      borderBottom: "1px solid var(--border)",
      background: "var(--bg-secondary)",
    };

    const title: React.CSSProperties = {
      fontSize: 13,
      fontWeight: 650,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    const sub: React.CSSProperties = {
      fontSize: 12,
      color: "var(--fg-muted)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    const chip: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid var(--border)",
      background: "var(--accent)",
      color: "var(--accent-fg)",
      fontSize: 12,
    };

    const btn: React.CSSProperties = {
      padding: "8px 10px",
      borderRadius: 8,
      border: "1px solid var(--action-bar-border)",
      background: "var(--action-bar-bg)",
      color: "var(--action-bar-fg)",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 650,
    };

    const btnDisabled: React.CSSProperties = {
      opacity: 0.55,
      cursor: "not-allowed",
    };

    const main: React.CSSProperties = {
      flex: 1,
      minHeight: 0,
      display: "grid",
      gridTemplateColumns: "260px 1fr",
      gap: 12,
      padding: 12,
      overflow: "hidden",
    };

    const card: React.CSSProperties = {
      border: "1px solid var(--border)",
      borderRadius: 10,
      background: "var(--bg-secondary)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    };

    const cardHeader: React.CSSProperties = {
      padding: "10px 10px 8px",
      borderBottom: "1px solid var(--border)",
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 10,
    };

    const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700 };
    const cardMeta: React.CSSProperties = {
      fontSize: 12,
      color: "var(--fg-muted)",
    };

    const list: React.CSSProperties = {
      padding: 6,
      overflow: "auto",
      display: "flex",
      flexDirection: "column",
      gap: 2,
    };

    const listItemBase: React.CSSProperties = {
      padding: "6px 8px",
      borderRadius: 8,
      fontSize: 12,
      cursor: "pointer",
      userSelect: "none",
    };

    const editorWrap: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
      gap: 10,
      padding: 10,
      overflow: "hidden",
    };

    const textarea: React.CSSProperties = {
      width: "100%",
      minHeight: 140,
      resize: "vertical",
      padding: 10,
      borderRadius: 10,
      border: "1px solid var(--border)",
      background: "var(--bg)",
      color: "var(--fg)",
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.45,
      outline: "none",
    };

    const errorBox: React.CSSProperties = {
      border: "1px solid var(--error-fg)",
      background: "var(--error-bg)",
      color: "var(--error-fg)",
      borderRadius: 10,
      padding: 10,
      fontSize: 12,
      whiteSpace: "pre-wrap",
    };

    const tableWrap: React.CSSProperties = {
      flex: 1,
      minHeight: 0,
      overflow: "auto",
      borderRadius: 10,
      border: "1px solid var(--border)",
      background: "var(--bg)",
    };

    const table: React.CSSProperties = {
      borderCollapse: "collapse",
      width: "max-content",
      minWidth: "100%",
      fontSize: 12,
    };

    const th: React.CSSProperties = {
      position: "sticky",
      top: 0,
      zIndex: 1,
      background: "var(--action-bar-bg)",
      color: "var(--fg-secondary)",
      borderBottom: "1px solid var(--border)",
      padding: "8px 8px",
      textAlign: "left",
      whiteSpace: "nowrap",
      fontWeight: 700,
    };

    const td: React.CSSProperties = {
      borderBottom: "1px solid var(--border)",
      padding: "6px 8px",
      whiteSpace: "nowrap",
    };

    return {
      container,
      topbar,
      title,
      sub,
      chip,
      btn,
      btnDisabled,
      main,
      card,
      cardHeader,
      cardTitle,
      cardMeta,
      list,
      listItemBase,
      editorWrap,
      textarea,
      errorBox,
      tableWrap,
      table,
      th,
      td,
    };
  }, []);
}

function App({ editorProps }: { editorProps: EditorProps }) {
  const s = useStyles();
  const [sql, setSql] = useState(DEFAULT_QUERY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [statusMsg, setStatusMsg] = useState<string>("Loading database…");
  const [tables, setTables] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult>({ kind: "empty" });
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hoveredTable, setHoveredTable] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dotdir.onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        void runQuery();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      setStatusMsg("Loading database…");
      setResult({ kind: "empty" });
      try {
        const buffer = await dotdir.readFile(editorProps.filePath);
        if (cancelled) return;

        const SQL: SqlJsStatic = await initSqlJs({
          locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : file),
        });
        if (cancelled) return;

        if (dbInstance) {
          try {
            dbInstance.close();
          } catch {
            // ignore
          }
          dbInstance = null;
        }
        dbInstance = new SQL.Database(new Uint8Array(buffer));

        const res = dbInstance.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
        );
        const names = (res[0]?.values ?? []).map((row) => String(row[0]));
        setTables(names);

        setStatus("ready");
        setStatusMsg("Ready");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setStatusMsg("Failed to load database");
        setResult({ kind: "error", message: msg });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editorProps.filePath]);

  async function runQuery(sqlOverride?: string): Promise<void> {
    const db = dbInstance;
    if (!db) return;

    const trimmed = (sqlOverride ?? sql).trim();
    if (trimmed.length === 0) {
      setResult({ kind: "empty" });
      return;
    }

    if (isLikelyMutating(trimmed)) {
      setResult({
        kind: "error",
        message:
          "This editor currently runs read-only queries only.\n\nAllowed: SELECT / WITH / PRAGMA\nBlocked: INSERT / UPDATE / DELETE / CREATE / DROP / ALTER / etc.",
      });
      return;
    }

    try {
      const rows = db.exec(trimmed);
      const first = rows[0];
      if (!first) {
        setResult({ kind: "empty" });
        return;
      }
      const cols = first.columns ?? [];
      const vals = (first.values ?? []).map((r) => r.map(fmtVal));
      if (cols.length > 0 && vals.length === 0) {
        setResult({ kind: "no_rows", columns: cols });
        return;
      }
      if (cols.length === 0) {
        setResult({ kind: "empty" });
        return;
      }
      setResult({
        kind: "table",
        columns: cols,
        rows: vals,
        rowCount: vals.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ kind: "error", message: msg });
    }
  }

  async function setQueryForTable(tableName: string) {
    const q = `SELECT * FROM "${tableName}" LIMIT 200;`;
    setSql(q);
    setSelectedTable(tableName);
    setResult({ kind: "empty" });
    // Execute using the explicit SQL so we don't depend on state timing.
    await runQuery(q);
  }

  return (
    <div style={s.container}>
      <div style={s.topbar}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 0,
          }}
        >
          <div style={s.title}>{editorProps.fileName}</div>
          <div style={s.sub}>{statusMsg} · Cmd/Ctrl+Enter to run</div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <span style={s.chip}>
            <span style={{ opacity: 0.85 }}>Tables</span>
            <strong style={{ fontWeight: 800 }}>{tables.length}</strong>
          </span>
          <button
            style={{ ...s.btn, ...(status !== "ready" ? s.btnDisabled : null) }}
            onClick={() => void runQuery()}
            disabled={status !== "ready"}
            title="Run query (Cmd/Ctrl+Enter)"
          >
            Run
          </button>
        </div>
      </div>

      <div style={s.main}>
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={s.cardTitle}>Tables</div>
            <div style={s.cardMeta}>click to query</div>
          </div>
          <div style={s.list}>
            {tables.length === 0 ? (
              <div
                style={{
                  padding: "8px 8px",
                  fontSize: 12,
                  color: "var(--fg-muted)",
                }}
              >
                {status === "loading" ? "Loading…" : "No tables found."}
              </div>
            ) : (
              tables.map((t) => (
                <div
                  key={t}
                  style={{
                    ...s.listItemBase,
                    background:
                      selectedTable === t
                        ? "var(--entry-selected)"
                        : hoveredTable === t
                          ? "var(--entry-hover)"
                          : "transparent",
                    color:
                      selectedTable === t
                        ? "var(--entry-selected-fg)"
                        : "inherit",
                    border:
                      selectedTable === t
                        ? "1px solid var(--border-active)"
                        : "1px solid transparent",
                  }}
                  onMouseEnter={() => setHoveredTable(t)}
                  onMouseLeave={() => setHoveredTable(null)}
                  onClick={() => void setQueryForTable(t)}
                  title={`SELECT * FROM "${t}" LIMIT 200`}
                >
                  {t}
                </div>
              ))
            )}
          </div>
        </div>

        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={s.cardTitle}>Query</div>
            <div style={s.cardMeta}>read-only</div>
          </div>
          <div style={s.editorWrap}>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              style={s.textarea}
              spellCheck={false}
            />

            {result.kind === "error" && (
              <div style={s.errorBox}>{result.message}</div>
            )}

            {result.kind === "table" && (
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                {result.rowCount} rows
              </div>
            )}

            {result.kind === "no_rows" && (
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                No rows to show.
              </div>
            )}

            {result.kind === "table" && (
              <div style={s.tableWrap}>
                <table style={s.table} role="grid">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c} style={s.th}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, idx) => (
                      <tr key={idx}>
                        {r.map((cell, j) => (
                          <td key={j} style={s.td}>
                            {cell === null ? (
                              <span style={{ color: "var(--fg-muted)" }}>
                                NULL
                              </span>
                            ) : (
                              String(cell)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.kind === "no_rows" && (
              <div style={s.tableWrap}>
                <table style={s.table} role="grid">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c} style={s.th}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody />
                </table>
              </div>
            )}

            {result.kind === "empty" && status === "ready" && (
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                Tip: click a table on the left, or run the default query.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

let reactRoot: Root | null = null;
let mountedRootEl: HTMLElement | null = null;
let dbInstance: Database | null = null;

export async function mountEditor(
  root: HTMLElement,
  props: EditorProps,
): Promise<void> {
  root.innerHTML = "";
  root.style.margin = "0";
  root.style.padding = "0";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.overflow = "hidden";

  mountedRootEl = root;
  reactRoot = createRoot(root);
  reactRoot.render(<App editorProps={props} />);
}

export function unmountEditor(): void {
  reactRoot?.unmount();
  reactRoot = null;
  if (mountedRootEl) mountedRootEl.innerHTML = "";
  mountedRootEl = null;
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}
