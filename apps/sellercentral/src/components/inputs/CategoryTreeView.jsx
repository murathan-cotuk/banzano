"use client";

import React, { useEffect, useState } from "react";

/** Build a nested tree from a flat category array using parent_id (same shape as settings/CategoriesPage.jsx). */
export function buildCategoryTree(flat) {
  const map = new Map();
  (flat || []).forEach((c) => { if (c?.id) map.set(c.id, { ...c, children: [] }); });
  const roots = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function TreeNode({ node, depth, allOpen, renderRow }) {
  const [open, setOpen] = useState(allOpen);
  const hasChildren = node.children && node.children.length > 0;

  useEffect(() => { setOpen(allOpen); }, [allOpen]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: 12 + depth * 20,
          paddingRight: 12,
          paddingTop: 6,
          paddingBottom: 6,
          borderBottom: "1px solid #f1f1f1",
        }}
      >
        <button
          type="button"
          onClick={() => hasChildren && setOpen((o) => !o)}
          style={{
            width: 20,
            height: 20,
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: hasChildren ? "pointer" : "default",
          }}
        >
          {hasChildren ? (
            <span
              style={{
                fontSize: 15,
                color: "#6b7280",
                display: "inline-block",
                transform: `rotate(${open ? "90deg" : "0deg"})`,
                transition: "transform 0.15s ease",
                lineHeight: 1,
              }}
            >
              ›
            </span>
          ) : (
            <span style={{ fontSize: 16, color: "#d1d5db", lineHeight: 1 }}>·</span>
          )}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>{renderRow(node, depth)}</div>
      </div>
      {hasChildren && open && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} allOpen={allOpen} renderRow={renderRow} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Reusable collapsible category tree (same drilldown pattern as settings/CategoriesPage.jsx):
 * roots shown first, click the chevron to reveal children one level at a time.
 * `renderRow(node, depth)` renders the row content (name/badges/actions) — layout/toggle is shared.
 */
export default function CategoryTreeView({ categories, renderRow, allOpen = false }) {
  const tree = React.useMemo(() => buildCategoryTree(categories), [categories]);
  if (tree.length === 0) return null;
  return (
    <div>
      {tree.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} allOpen={allOpen} renderRow={renderRow} />
      ))}
    </div>
  );
}
