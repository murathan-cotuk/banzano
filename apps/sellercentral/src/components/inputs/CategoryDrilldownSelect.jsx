"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Text, TextField } from "@shopify/polaris";
import { useLocale } from "next-intl";
import { categoryDisplayName } from "@/lib/category-locale";

function normalizeCategories(list, locale) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const c of list) {
    if (!c?.id) continue;
    byId.set(c.id, { ...c, children: [] });
  }
  for (const node of byId.values()) {
    const pid = node.parent_id;
    if (pid && byId.has(pid)) byId.get(pid).children.push(node);
  }
  const sortNodes = (arr, locale) =>
    arr.sort((a, b) =>
      categoryDisplayName(a, locale).localeCompare(categoryDisplayName(b, locale), undefined, { sensitivity: "base" })
    );
  const roots = [];
  for (const node of byId.values()) {
    if (!node.parent_id || !byId.has(node.parent_id)) roots.push(node);
  }
  const sortDeep = (arr, locale) => {
    sortNodes(arr, locale);
    arr.forEach((n) => n.children?.length && sortDeep(n.children, locale));
  };
  sortDeep(roots, locale);
  return roots;
}

export default function CategoryDrilldownSelect({
  label = "Category",
  labelHidden = false,
  categories = [],
  value = "",
  onChange,
  placeholder = "Select category",
  noneLabel = "— None —",
  disabled = false,
}) {
  const locale = useLocale();
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [triggerRect, setTriggerRect] = useState(null);
  const [search, setSearch] = useState("");
  const [pathIds, setPathIds] = useState([]);

  const tree = useMemo(() => normalizeCategories(categories, locale), [categories, locale]);
  const byId = useMemo(() => {
    const map = new Map();
    const walk = (nodes) => {
      for (const n of nodes) {
        map.set(n.id, n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const selectedNode = value ? byId.get(value) : null;
  const selectedBreadcrumb = useMemo(() => {
    if (!selectedNode) return "";
    const parts = [];
    let cur = selectedNode;
    while (cur) {
      parts.unshift(categoryDisplayName(cur, locale));
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    return parts.join(" > ");
  }, [selectedNode, byId, locale]);

  const labelFor = (node) => categoryDisplayName(node, locale);

  const buildPathIds = (id) => {
    if (!id || !byId.has(id)) return [];
    const rev = [];
    let cur = byId.get(id);
    while (cur) {
      rev.push(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    return rev.reverse();
  };

  const currentNodes = useMemo(() => {
    if (!pathIds.length) return tree;
    const last = byId.get(pathIds[pathIds.length - 1]);
    return last?.children || [];
  }, [pathIds, byId, tree]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const rows = [];
    for (const n of byId.values()) {
      const display = labelFor(n);
      const hay = `${display} ${n.name || ""} ${n.slug || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
      const breadcrumb = buildPathIds(n.id)
        .map((id) => labelFor(byId.get(id) || { id }))
        .join(" > ");
      rows.push({ id: n.id, label: display, breadcrumb });
    }
    rows.sort((a, b) => a.breadcrumb.localeCompare(b.breadcrumb, undefined, { sensitivity: "base" }));
    return rows.slice(0, 100);
  }, [search, byId, locale]);

  useEffect(() => {
    if (!open) return;
    setPathIds(buildPathIds(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setTriggerRect(rect);
        setOpenUpward(window.innerHeight - rect.bottom < 340);
      }
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // The dropdown is `position: fixed` so it can escape the white card, but it's still a DOM
  // descendant of the scrollable page wrapper — that wrapper's `overflow` still clips it visually.
  // Toggling this body class flips the wrapper to `overflow: visible` while the dropdown is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) document.body.classList.add("andertal-dropdown-open");
    else document.body.classList.remove("andertal-dropdown-open");
    return () => document.body.classList.remove("andertal-dropdown-open");
  }, [open]);

  useEffect(() => {
    const onDown = (e) => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target)) return;
      if (dropdownRef.current && dropdownRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const handleSelect = (nodeId) => {
    const node = byId.get(nodeId);
    onChange?.(nodeId);
    if (!node) return;
    setPathIds(buildPathIds(nodeId));
    setSearch("");
    if (!node.children?.length) setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative", width: "100%" }}>
      {!labelHidden && (
        <div style={{ marginBottom: 6 }}>
          <Text as="span" variant="bodySm" fontWeight="medium">{label}</Text>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          width: "100%",
          minHeight: 36,
          border: "1px solid var(--p-color-border)",
          borderRadius: 8,
          background: disabled ? "var(--p-color-bg-surface-disabled, #f1f2f4)" : "var(--p-color-bg-surface)",
          textAlign: "left",
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--p-color-text)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        aria-label={label}
      >
        <span style={{ color: selectedBreadcrumb ? "var(--p-color-text)" : "var(--p-color-text-subdued)" }}>
          {selectedBreadcrumb || placeholder}
        </span>
        <span style={{ float: "right", color: "var(--p-color-text-subdued)" }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && !disabled && triggerRect && typeof document !== "undefined" && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            ...(openUpward
              ? { bottom: window.innerHeight - triggerRect.top + 4 }
              : { top: triggerRect.bottom + 4 }),
            left: triggerRect.left,
            width: triggerRect.width,
            zIndex: 10020,
            background: "var(--p-color-bg-surface)",
            border: "1px solid var(--p-color-border)",
            borderRadius: 10,
            boxShadow: "var(--p-shadow-400)",
            padding: 10,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <TextField
              label="Search category"
              labelHidden
              value={search}
              onChange={setSearch}
              placeholder="Type to search categories..."
              autoComplete="off"
            />
          </div>

          {!search.trim() && (
            <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  onChange?.("");
                  setPathIds([]);
                  setOpen(false);
                }}
                style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer", fontSize: 12, padding: 0 }}
              >
                {noneLabel}
              </button>
              {pathIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPathIds((prev) => prev.slice(0, -1))}
                  style={{ border: "none", background: "none", color: "#374151", cursor: "pointer", fontSize: 12, padding: 0 }}
                >
                  ← Back
                </button>
              )}
            </div>
          )}

          {!search.trim() && pathIds.length > 0 && (
            <div style={{ marginBottom: 8, fontSize: 12, color: "#6b7280" }}>
              {pathIds.map((id) => labelFor(byId.get(id) || { id })).join(" > ")}
            </div>
          )}

          <div style={{ maxHeight: 260, overflowY: "auto", borderTop: "1px solid #f1f2f4", paddingTop: 8 }}>
            {search.trim()
              ? searchResults.map((row) => (
                  <button
                    type="button"
                    key={row.id}
                    onClick={() => handleSelect(row.id)}
                    style={{
                      width: "100%",
                      border: "none",
                      background: value === row.id ? "#eff6ff" : "transparent",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{row.label}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{row.breadcrumb}</div>
                  </button>
                ))
              : currentNodes.map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    onClick={() => handleSelect(node.id)}
                    style={{
                      width: "100%",
                      border: "none",
                      background: value === node.id ? "#eff6ff" : "transparent",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 8,
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 13, color: "#111827" }}>{labelFor(node)}</span>
                    <span style={{ fontSize: 12, color: "#9ca3af" }}>{node.children?.length ? `${node.children.length} ›` : ""}</span>
                  </button>
                ))}

            {search.trim() && searchResults.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "#9ca3af" }}>No category found.</div>
            )}
            {!search.trim() && currentNodes.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "#9ca3af" }}>No child category in this level.</div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

