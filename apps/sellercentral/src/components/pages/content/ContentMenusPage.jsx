"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  TextField,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  Modal,
  Select,
  EmptyState,
  Popover,
  ActionList,
} from "@shopify/polaris";
import { PlusIcon, EditIcon, DeleteIcon } from "@shopify/polaris-icons";

const CheckIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden><path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0Z" /></svg>
);
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { titleToHandle } from "@/lib/slugify";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import SearchableSelect from "@/components/inputs/SearchableSelect";
import { confirmDelete } from "@/lib/confirm-delete";
import { useLocale } from "next-intl";
import { getContentMenusCopy, linkTypesForLocale, apiFunctionOptionsForLocale } from "@/lib/content-menus-i18n";
import { getLandingEditorCopy } from "@/lib/landing-page-editor-i18n";
import { showToast } from "@/lib/toast";

/** Read a translatable field: DE lives on the plain column, other languages under the *_i18n jsonb column. */
function giI18n(obj, field, i18nKey, lang) {
  if (!lang || lang === "de") return obj?.[field] ?? "";
  return obj?.[i18nKey]?.[lang]?.[field] ?? "";
}
/** Merge a translated field into an *_i18n object for the given language, leaving other languages untouched. */
function setI18nField(i18nObj, field, lang, value) {
  return { ...(i18nObj || {}), [lang]: { ...(i18nObj?.[lang] || {}), [field]: value } };
}

const TAB_SIZE = 28;
const NEST_BOUNDARY_PX = 20 + 3 * TAB_SIZE;

function slugFromName(name) {
  return titleToHandle(name || "");
}

function normalizeItemSlug(value) {
  return titleToHandle(value || "");
}

function buildMenuTree(items) {
  if (!Array.isArray(items)) return [];
  const byId = new Map(items.map((i) => [i.id, { ...i, children: [] }]));
  const roots = [];
  for (const i of items) {
    const node = byId.get(i.id);
    if (!i.parent_id) {
      roots.push(node);
    } else {
      const parent = byId.get(i.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (arr) => arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.label || "").localeCompare(b.label || ""));
  sort(roots);
  roots.forEach((r) => sort(r.children));
  return roots;
}

function flattenMenuTree(nodes, level = 0) {
  if (!Array.isArray(nodes)) return [];
  let out = [];
  for (const node of nodes) {
    out.push({ ...node, _level: level });
    if (node.children?.length) out = out.concat(flattenMenuTree(node.children, level + 1));
  }
  return out;
}

/** Normalizes API categories (flat parent_id list or tree with children) to root nodes with nested children. */
function normalizeCategoryTree(list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.some((c) => Array.isArray(c.children) && c.children.length)) return list;
  const byId = new Map(list.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of list) {
    const node = byId.get(c.id);
    if (!c.parent_id) roots.push(node);
    else {
      const parent = byId.get(c.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (arr) =>
    arr.sort(
      (a, b) =>
        (a.sort_order || 0) - (b.sort_order || 0) ||
        String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || ""))
    );
  const sortDeep = (arr) => {
    sort(arr);
    arr.forEach((r) => {
      if (r.children?.length) sortDeep(r.children);
    });
  };
  sortDeep(roots);
  return roots;
}

function collectCategoriesDepthFirst(roots) {
  const acc = [];
  const walk = (nodes) => {
    for (const c of nodes || []) {
      acc.push(c);
      if (c.children?.length) walk(c.children);
    }
  };
  walk(roots);
  return acc;
}

function findCategoryById(list, id) {
  if (!id || !Array.isArray(list)) return null;
  const roots = normalizeCategoryTree(list);
  const all = collectCategoriesDepthFirst(roots);
  return all.find((c) => String(c.id) === String(id)) || null;
}

/** Parse semicolon-separated hierarchical CSV (e.g. Main Category;Subcategory 1;...) into a flat create list preserving hierarchy and order. */
function parseCategoriesCsvToCreateList(csvText) {
  const lines = (csvText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return []; // need header + at least one row
  const header = lines[0];
  const rows = lines.slice(1);
  const separator = header.includes(";") ? ";" : ",";
  const labelMap = {}; // key -> label
  const childrenMap = {}; // parentKey -> ordered child keys (first appearance order)
  const seenKeys = new Set();
  for (const line of rows) {
    const segments = line.split(separator).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const label = segments[i];
      const parentKey = i === 0 ? "" : segments.slice(0, i).join("|");
      const key = segments.slice(0, i + 1).join("|");
      if (!label) continue;
      labelMap[key] = label;
      if (!childrenMap[parentKey]) childrenMap[parentKey] = [];
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        childrenMap[parentKey].push(key);
      }
    }
  }
  // BFS so parents are always before children
  const createList = [];
  const queue = [""];
  while (queue.length) {
    const parentKey = queue.shift();
    const childKeys = childrenMap[parentKey] || [];
    for (let i = 0; i < childKeys.length; i++) {
      const key = childKeys[i];
      createList.push({
        key,
        label: labelMap[key] || key,
        parentKey,
        sortOrder: i,
      });
      queue.push(key);
    }
  }
  return createList;
}

function MenuEditorPanel(props) {
  const {
    uiLocale,
    editLang,
    setEditLang,
    panelMode,
    panelMenuId,
    selectedMenuId,
    panelMenu,
    menuForm,
    setMenuForm,
    menuSlugManuallyEdited,
    setMenuSlugManuallyEdited,
    handleMenuNameChange,
    slugFromName,
    items,
    flatItems,
    effectiveMenuId,
    fetchMenus,
    fetchItems,
    closePanel,
    handleDuplicateMenu,
    handleDeleteMenu,
    setError,
    saving,
    setSaving,
    client,
    collections,
    categories,
    products,
    pages,
    LINK_TYPES,
    API_FUNCTION_OPTIONS,
    menusCopy,
    getLinkDisplay,
    TAB_SIZE,
    buildMenuTree,
    flattenMenuTree,
    getNextSortOrder,
    handleMoveItem,
    handleDeleteItem,
    draggedItemId,
    dropTarget,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
    dragJustEndedRef,
    isClickAfterDrag,
    popoverActiveId,
    setPopoverActiveId,
    inlineEditingId,
    setInlineEditingId,
    inlineNewOpen,
    setInlineNewOpen,
    itemForm,
    setItemForm,
    editingItemId,
    setEditingItemId,
    addUnderParentId,
    setAddUnderParentId,
    openAddItem,
    openEditItem,
    handleSaveItem,
    parentOptionsForForm,
    expandedIds,
    setExpandedIds,
    router,
    onOpenImportCsv,
    onMenuSaved,
    locationOptions = [],
    onDirtyChange,
  } = props;
  const tree = buildMenuTree(items);
  const openInlineAdd = (parentId) => {
    setAddUnderParentId(parentId ?? null);
    setItemForm({ label: "", label_i18n: {}, slug: "", link_type: "url", link_value: "", parent_id: parentId ?? "", category_id: "", collection_id: "", product_id: "", page_id: "", blog_post_id: "", custom_slug: "", api_function: "brand" });
    setInlineNewOpen(true);
    setEditingItemId(null);
  };
  const [localMenuName, setLocalMenuName] = useState(panelMenu?.name ?? menuForm.name ?? "");
  const [localMenuNameI18n, setLocalMenuNameI18n] = useState(panelMenu?.name_i18n ?? {});
  const [localMenuSlug, setLocalMenuSlug] = useState(panelMenu?.slug ?? menuForm.slug ?? "");
  const [localMenuLocation, setLocalMenuLocation] = useState(panelMenu?.location ?? menuForm.location ?? "main");
  const isNew = panelMode === "new";
  const hasMenuId = !!effectiveMenuId && !isNew;
  const langOptions = getLandingEditorCopy(uiLocale).shopContentLangOptions();
  const displayedMenuName = editLang === "de" ? localMenuName : (localMenuNameI18n?.[editLang]?.name || "");
  const setDisplayedMenuName = (value) => {
    if (editLang === "de") {
      setLocalMenuName(value);
      if (!menuSlugManuallyEdited) setLocalMenuSlug(slugFromName(value));
    } else {
      setLocalMenuNameI18n((prev) => setI18nField(prev, "name", editLang, value));
    }
  };

  // Always-current refs so save/discard callbacks never go stale
  const latestSaveRef = useRef(null);
  const latestDiscardRef = useRef(null);

  const menuFormDirty = isNew
    ? !!(localMenuName?.trim() || localMenuSlug?.trim())
    : (localMenuName !== (panelMenu?.name ?? "")) || (localMenuSlug !== (panelMenu?.slug ?? "")) || (localMenuLocation !== (panelMenu?.location ?? "main"))
      || JSON.stringify(localMenuNameI18n || {}) !== JSON.stringify(panelMenu?.name_i18n || {});

  useEffect(() => {
    if (panelMenu) {
      setLocalMenuName(panelMenu.name ?? "");
      setLocalMenuNameI18n(panelMenu.name_i18n ?? {});
      setLocalMenuSlug(panelMenu.slug ?? "");
      setLocalMenuLocation(panelMenu.location ?? "main");
      setMenuSlugManuallyEdited(false);
    } else if (isNew) {
      setLocalMenuName(menuForm.name);
      setLocalMenuNameI18n({});
      setLocalMenuSlug(menuForm.slug);
      setLocalMenuLocation(menuForm.location ?? "main");
      setMenuSlugManuallyEdited(false);
    }
  }, [panelMenu, isNew, menuForm.name, menuForm.slug, menuForm.location]);

  useEffect(() => {
    if (typeof onDirtyChange !== "function") return;
    if (menuFormDirty) {
      onDirtyChange(true, { save: () => latestSaveRef.current?.(), discard: () => latestDiscardRef.current?.() });
    } else {
      onDirtyChange(false);
    }
  }, [menuFormDirty, onDirtyChange]);

  const handleDiscardMenuForm = () => {
    if (panelMenu) {
      setLocalMenuName(panelMenu.name ?? "");
      setLocalMenuNameI18n(panelMenu.name_i18n ?? {});
      setLocalMenuSlug(panelMenu.slug ?? "");
      setLocalMenuLocation(panelMenu.location ?? "main");
      setMenuSlugManuallyEdited(false);
    } else {
      setLocalMenuName(menuForm.name);
      setLocalMenuNameI18n({});
      setLocalMenuSlug(menuForm.slug);
      setLocalMenuLocation(menuForm.location ?? "main");
      setMenuSlugManuallyEdited(false);
    }
  };
  latestDiscardRef.current = handleDiscardMenuForm;

  const handleSaveMenuFromPanel = async () => {
    const name = (localMenuName || "").trim();
    const slug = (localMenuSlug || slugFromName(localMenuName || "")).trim();
    if (!name || !slug) {
      setError(menusCopy.nameSlugRequired);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const location = localMenuLocation || "main";
      if (isNew) {
        const created = await client.createMenu({ name, slug, location, name_i18n: localMenuNameI18n });
        await fetchMenus();
        if (router) router.push(`/content/menus/${created.id}`);
        return;
      }
      if (panelMenuId) {
        await client.updateMenu(panelMenuId, { name, slug, location, name_i18n: localMenuNameI18n });
        await fetchMenus();
        if (onMenuSaved) await onMenuSaved(panelMenuId);
      }
      showToast(menusCopy.saved);
    } catch (err) {
      setError(err?.message || "Failed to save menu");
    } finally {
      setSaving(false);
    }
  };
  latestSaveRef.current = handleSaveMenuFromPanel;

  const inlineSaveItem = async () => {
    await handleSaveItem();
    setInlineEditingId(null);
    setInlineNewOpen(false);
  };

  const handleCategoriesWithProducts = async () => {
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId) return;
    try {
      setSaving(true);
      setError(null);
      const nextValue = !Boolean(panelMenu?.categories_with_products);
      const payload = {
        name: localMenuName || panelMenu?.name || "",
        slug: localMenuSlug || panelMenu?.slug || "",
        location: localMenuLocation || panelMenu?.location || "main",
        categories_with_products: nextValue,
      };
      await client.updateMenu(menuId, payload);
      await fetchMenus();
      await fetchItems(menuId);
    } catch (err) {
      setError(err?.message || "Failed to update categories-with-products mode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateX(-50%) translateY(100%); } to { transform: translateX(-50%) translateY(0); } }
        .menu-items-card .menu-add-row:hover { background: var(--p-color-bg-surface-secondary) !important; }
      `}</style>
      <div style={{ padding: "28px 32px", borderBottom: "1px solid var(--p-color-border-subdued)", flexShrink: 0, background: "var(--p-color-bg-surface)" }}>
<BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="400">
            <div style={{ flex: 1, minWidth: 0 }}>
              <BlockStack gap="200">
                <TextField
                  label={menusCopy.menuName}
                  value={displayedMenuName}
                  onChange={setDisplayedMenuName}
                  placeholder={menusCopy.menuNamePh}
                  autoComplete="off"
                  helpText={editLang !== "de" ? menusCopy.menuNamePh : undefined}
                />
                {editLang === "de" && (
                  <TextField
                    label={menusCopy.itemSlug}
                    value={localMenuSlug}
                    onChange={(value) => {
                      setMenuSlugManuallyEdited(true);
                      setLocalMenuSlug(value);
                    }}
                    placeholder={menusCopy.menuSlugPh}
                    autoComplete="off"
                    helpText={menusCopy.slugHelp}
                  />
                )}
              </BlockStack>
            </div>
            <div style={{ minWidth: 160 }}>
              <Select
                label="Language"
                labelHidden
                options={langOptions}
                value={editLang}
                onChange={setEditLang}
              />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select
                label="Location"
                labelHidden
                options={locationOptions}
                value={localMenuLocation || "main"}
                onChange={setLocalMenuLocation}
              />
              <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "var(--p-color-text-subdued)" }}>
                {localMenuLocation === "second" ? menusCopy.locationSecond : localMenuLocation === "main" ? menusCopy.locationMain : menusCopy.locationOther}
              </span>
            </div>
            <InlineStack gap="200" blockAlign="center">
              {hasMenuId && (
                <Button size="slim" variant="secondary" onClick={() => handleDuplicateMenu(panelMenu)} disabled={saving}>
                  {menusCopy.duplicate}
                </Button>
              )}
              {hasMenuId && (
                <Button size="slim" variant="critical" onClick={() => handleDeleteMenu(null, panelMenu || { id: panelMenuId, name: localMenuName })} disabled={saving}>
                  {menusCopy.delete}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </div>
      <div style={{ padding: "24px 32px" }}>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" wrap gap="300">
            <Text as="h3" variant="headingMd" fontWeight="semibold">{menusCopy.menuItems}</Text>
            <InlineStack gap="300" blockAlign="center">
              {hasMenuId && (
                <button
                  type="button"
                  onClick={handleCategoriesWithProducts}
                  disabled={saving}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8, cursor: saving ? "not-allowed" : "pointer",
                    padding: "5px 12px", borderRadius: 8, border: "1px solid",
                    borderColor: panelMenu?.categories_with_products ? "#16a34a" : "var(--p-color-border-subdued)",
                    background: panelMenu?.categories_with_products ? "#f0fdf4" : "var(--p-color-bg-surface)",
                    color: panelMenu?.categories_with_products ? "#166534" : "var(--p-color-text-subdued)",
                    fontSize: 13, fontWeight: 500, transition: "all 0.15s",
                  }}
                >
                  <span style={{
                    width: 32, height: 18, borderRadius: 9, display: "inline-block", flexShrink: 0, position: "relative",
                    background: panelMenu?.categories_with_products ? "#16a34a" : "#d1d5db", transition: "background 0.15s",
                  }}>
                    <span style={{
                      position: "absolute", top: 2, left: panelMenu?.categories_with_products ? 16 : 2,
                      width: 14, height: 14, borderRadius: "50%", background: "#fff",
                      transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                    }} />
                  </span>
                  {menusCopy.categoriesWithProducts}
                </button>
              )}
              {typeof onOpenImportCsv === "function" && (
                <Button variant="secondary" size="slim" onClick={onOpenImportCsv}>
                  {menusCopy.importCsv}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
          <div
            className="menu-items-card"
            style={{
              border: "1px solid var(--p-color-border-subdued)",
              borderRadius: "16px",
              overflow: "hidden",
              background: "var(--p-color-bg-surface)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}
          >
            {panelMenu?.categories_with_products ? (
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--p-color-border-subdued)", background: "#f0fdf4", display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="#16a34a"><path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.707-9.293a1 1 0 0 0-1.414-1.414L9 10.586 7.707 9.293a1 1 0 0 0-1.414 1.414l2 2a1 1 0 0 0 1.414 0l4-4z" clipRule="evenodd" /></svg>
                <Text as="p" tone="success">{menusCopy.autoCategoriesOn}</Text>
              </div>
            ) : null}
            {hasMenuId && (
              <>
                {panelMenu?.categories_with_products ? null : (() => {
                  const addButton = (parentId, depth) => {
                    const indent = parentId != null ? (depth + 1) * 3 * TAB_SIZE : 0;
                    return (
                      <button
                        key={parentId === null ? "add-root" : `add-${parentId}`}
                        type="button"
                        onClick={() => openInlineAdd(parentId)}
                        className="menu-add-row"
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--p-color-bg-surface-secondary)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "12px 20px",
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          textAlign: "left",
                          color: "var(--p-color-text-secondary)",
                          fontSize: "14px",
                          fontFamily: "inherit",
                          paddingLeft: 20 + indent,
                          transition: "background 0.15s",
                          borderRadius: "0 0 16px 16px",
                        }}
                      >
                        <span style={{ color: "var(--p-color-icon-highlight)", flexShrink: 0 }}>
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M10 5a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 10 5" /></svg>
                        </span>
                        <span style={{ fontWeight: 500 }}>{menusCopy.addMenuItem}</span>
                      </button>
                    );
                  };
                  const renderNodes = (nodes, depth) => {
                    const out = [];
                    for (const node of nodes) {
                      if (node.id === inlineEditingId) {
                        out.push(
                          <div key={node.id} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                            <InlineItemRow
                              editLang={editLang}
                              itemForm={itemForm}
                              setItemForm={setItemForm}
                              menusCopy={menusCopy}
                              collections={collections}
                              categories={categories}
                              products={products}
                              pages={pages}
                              LINK_TYPES={LINK_TYPES}
                              apiFunctionOptions={API_FUNCTION_OPTIONS}
                              flatItems={flatItems}
                              parentOptionsForForm={parentOptionsForForm}
                              onSave={async () => { await handleSaveItem(); setInlineEditingId(null); }}
                              onCancel={() => setInlineEditingId(null)}
                              saving={saving}
                            />
                          </div>
                        );
                      } else {
                        const hasChildren = node.children?.length > 0;
                        const expanded = expandedIds.has(node.id);
                        const dt = dropTarget || {};
                        const showAbove = dt.type === "above" && String(dt.id) === String(node.id);
                        const showBelow = dt.type === "below" && String(dt.id) === String(node.id);
                        const showChild = dt.type === "child" && String(dt.id) === String(node.id);
                        const isDragging = String(draggedItemId) === String(node.id);
                        out.push(
                          <div
                            key={node.id}
                            style={{ position: "relative" }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (isDragging) return;
                              const rowEl = e.currentTarget.querySelector("[data-menu-row]");
                              const rect = rowEl ? rowEl.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
                              const x = e.clientX - rect.left;
                              const y = e.clientY - rect.top;
                              const rowHeight = rect.height;
                              let zone;
                              if (y < 0) zone = "above";
                              else if (y > rowHeight) zone = "below";
                              else if (x < NEST_BOUNDARY_PX) zone = y < rowHeight / 2 ? "above" : "below";
                              else zone = "child";
                              onDragOver(e, { type: zone, id: node.id });
                            }}
                            onDragLeave={onDragLeave}
                            onDrop={onDrop}
                          >
                            {showAbove && (
                              <div style={{ position: "relative", height: 2, background: "var(--p-color-border-info)", borderRadius: 1, pointerEvents: "none" }} aria-hidden>
                                <span style={{ position: "absolute", left: 20, top: "50%", transform: "translate(-50%, -50%)", width: 8, height: 8, borderRadius: "50%", background: "var(--p-color-border-info)", display: "block" }} aria-hidden />
                              </div>
                            )}
                            <div
                              data-menu-row
                              draggable
                              onDragStart={(e) => onDragStart(e, node.id)}
                              onDragEnd={onDragEnd}
                              onClick={(e) => {
                                if (isClickAfterDrag?.()) return;
                                if (e.target.closest("button") || e.target.closest("[data-drag-handle]")) return;
                                openEditItem(node);
                                setInlineEditingId(node.id);
                              }}
                              style={{
                                position: "relative",
                                display: "grid",
                                gridTemplateColumns: "40px 1fr auto",
                                gap: "12px",
                                padding: "10px 20px",
                                paddingLeft: depth >= 1 ? 20 + depth * 1 * TAB_SIZE : 20,
                                alignItems: "center",
                                minHeight: 48,
                                borderBottom: "1px solid var(--p-color-border-subdued)",
                                background: isDragging ? "var(--p-color-bg-surface-secondary)" : showChild ? "var(--p-color-bg-surface-selected)" : "var(--p-color-bg-surface)",
                                borderLeft: "transparent",
                                cursor: "grab",
                                opacity: isDragging ? 0.6 : 1,
                                transition: "background 0.15s, border-color 0.15s",
                              }}
                              onMouseEnter={(e) => { if (!isDragging && !showChild) e.currentTarget.style.background = "var(--p-color-bg-surface-secondary)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                            >
                              {showChild && (
                                <>
                                  <div style={{ position: "absolute", left: NEST_BOUNDARY_PX, top: 0, bottom: 0, width: 2, background: "var(--p-color-border-info)", borderRadius: 1, pointerEvents: "none" }} aria-hidden />
                                  <span style={{ position: "absolute", left: NEST_BOUNDARY_PX + 6, top: "50%", transform: "translateY(-50%)", width: 8, height: 8, borderRadius: "50%", background: "var(--p-color-border-info)", pointerEvents: "none" }} aria-hidden />
                                </>
                              )}
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }} data-drag-handle>
                                <div style={{ width: 24, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
                                  {hasChildren ? (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setExpandedIds((prev) => { const next = new Set(prev); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; }); }}
                                      style={{ padding: 4, border: "none", background: "none", cursor: "pointer", color: "var(--p-color-icon-subdued)", display: "flex" }}
                                      aria-label={expanded ? menusCopy.remove : menusCopy.addItem}
                                    >
                                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}><path d="M4 6l4 4 4-4H4z" /></svg>
                                    </button>
                                  ) : (
                                    <span style={{ width: 16, display: "inline-block" }} />
                                  )}
                                </div>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--p-color-icon-subdued)", flexShrink: 0 }} aria-hidden>
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="4" r="1.25" /><circle cx="6" cy="8" r="1.25" /><circle cx="6" cy="12" r="1.25" /><circle cx="10" cy="4" r="1.25" /><circle cx="10" cy="8" r="1.25" /><circle cx="10" cy="12" r="1.25" /></svg>
                                </div>
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <Text as="span" variant="bodyMd" fontWeight="medium">{node.label || "—"}</Text>
                                <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 1 }}>
                                  <span style={{ fontSize: 11, color: "var(--p-color-text-subdued)", fontFamily: "monospace" }}>/</span>
                                  <input
                                    type="text"
                                    key={node.id + "-slug"}
                                    defaultValue={node.slug || normalizeItemSlug(node.label || "")}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    onBlur={async (e) => {
                                      const newSlug = normalizeItemSlug(e.target.value || node.label || "");
                                      e.target.value = newSlug;
                                      const oldSlug = node.slug || normalizeItemSlug(node.label || "");
                                      if (newSlug === oldSlug) return;
                                      const menuId = effectiveMenuId ?? selectedMenuId;
                                      if (!menuId) return;
                                      try {
                                        await client.updateMenuItem(menuId, node.id, { slug: newSlug });
                                        await fetchItems(menuId);
                                      } catch {}
                                    }}
                                    style={{
                                      fontSize: 11,
                                      color: "var(--p-color-text-subdued)",
                                      border: "none",
                                      borderBottom: "1px dashed var(--p-color-border-subdued)",
                                      background: "transparent",
                                      padding: "0 2px",
                                      outline: "none",
                                      width: "auto",
                                      minWidth: 60,
                                      maxWidth: 200,
                                      fontFamily: "monospace",
                                      cursor: "text",
                                    }}
                                  />
                                </div>
                              </div>
                              <InlineStack gap="100" wrap={false}>
                                <Button size="slim" variant="plain" tone="subdued" accessibilityLabel={menusCopy.edit} icon={EditIcon} onClick={(e) => { e.stopPropagation(); if (isClickAfterDrag?.()) return; openEditItem(node); setInlineEditingId(node.id); }} />
                                <Button size="slim" variant="plain" tone="critical" accessibilityLabel={menusCopy.delete} icon={DeleteIcon} onClick={(e) => { e.stopPropagation(); if (isClickAfterDrag?.()) return; handleDeleteItem(node); }} />
                              </InlineStack>
                            </div>
                            {showBelow && (
                              <div style={{ position: "relative", height: 2, background: "var(--p-color-border-info)", borderRadius: 1, pointerEvents: "none" }} aria-hidden>
                                <span style={{ position: "absolute", left: 20, top: "50%", transform: "translate(-50%, -50%)", width: 8, height: 8, borderRadius: "50%", background: "var(--p-color-border-info)", display: "block" }} aria-hidden />
                              </div>
                            )}
                          </div>
                        );
                      }
                      if (node.children?.length && expandedIds.has(node.id)) {
                        out.push(...renderNodes(node.children, depth + 1));
                        out.push(addButton(node.id, depth));
                      }
                    }
                    return out;
                  };
                  return (
                    <>
                      {renderNodes(tree, 0)}
                      {inlineNewOpen && (
                        <div style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                          <InlineItemRow
                            editLang={editLang}
                            itemForm={itemForm}
                            setItemForm={setItemForm}
                            menusCopy={menusCopy}
                            collections={collections}
                            categories={categories}
                            products={products}
                            pages={pages}
                            LINK_TYPES={LINK_TYPES}
                            apiFunctionOptions={API_FUNCTION_OPTIONS}
                            flatItems={flatItems}
                            parentOptionsForForm={parentOptionsForForm}
                            onSave={inlineSaveItem}
                            onCancel={() => { setInlineNewOpen(false); setItemForm({ label: "", label_i18n: {}, slug: "", link_type: "url", link_value: "", parent_id: "", category_id: "", collection_id: "", product_id: "", page_id: "", blog_post_id: "", custom_slug: "", api_function: "brand" }); }}
                            saving={saving}
                          />
                        </div>
                      )}
                      {addButton(null, -1)}
                    </>
                  );
                })()}
              </>
            )}
            {!hasMenuId && (
              <div style={{ padding: "24px", color: "var(--p-color-text-subdued)" }}>
                {isNew ? menusCopy.save : menusCopy.loading}
              </div>
            )}
          </div>
        </BlockStack>
      </div>
    </>
  );
}

function InlineItemRow({ editLang, itemForm, setItemForm, menusCopy, collections, categories, products, pages, LINK_TYPES, apiFunctionOptions, flatItems, parentOptionsForForm, onSave, onCancel, saving }) {
  const displayedLabel = !editLang || editLang === "de" ? (itemForm.label || "") : (itemForm.label_i18n?.[editLang]?.label || "");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr auto", gap: "16px", padding: "14px 20px", alignItems: "center", background: "var(--p-color-bg-surface-secondary)", borderRadius: "8px", margin: "8px 12px" }}>
      <span />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(160px, 220px)", gap: 8, alignItems: "center" }}>
        <TextField
          label={LINK_TYPES?.length ? "Label" : "Label"}
          value={displayedLabel}
          onChange={(v) => setItemForm((p) => {
            if (!editLang || editLang === "de") {
              return {
                ...p,
                label: v,
                slug: p.slug === normalizeItemSlug(p.label || "") || !p.slug ? normalizeItemSlug(v) : p.slug,
                custom_slug: p.custom_slug === normalizeItemSlug(p.label || "") || !p.custom_slug ? normalizeItemSlug(v) : p.custom_slug,
              };
            }
            return { ...p, label_i18n: setI18nField(p.label_i18n, "label", editLang, v) };
          })}
          placeholder={LINK_TYPES?.length ? "Label" : "Label"}
          autoComplete="off"
          labelHidden
        />
        {(!editLang || editLang === "de") && (
          <TextField
            label={LINK_TYPES?.length ? "Slug" : "Slug"}
            value={itemForm.slug || ""}
            onChange={(v) => setItemForm((p) => ({ ...p, slug: normalizeItemSlug(v), custom_slug: normalizeItemSlug(v) }))}
            placeholder="slug"
            autoComplete="off"
            labelHidden
          />
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Select label="Link type" options={LINK_TYPES} value={itemForm.link_type} onChange={(v) => setItemForm((p) => ({ ...p, link_type: v }))} labelHidden />
        {itemForm.link_type === "category" && (
          <div style={{ minWidth: 280, flex: 1 }}>
            <CategoryDrilldownSelect
              label="Category"
              labelHidden
              categories={categories || []}
              value={itemForm.category_id || ""}
              onChange={(v) => setItemForm((p) => ({ ...p, category_id: v }))}
              placeholder="Select category"
              noneLabel="— Select —"
            />
          </div>
        )}
        {itemForm.link_type === "collection" && (
          <Select label="Collection" labelHidden options={[{ label: `— ${menusCopy.selectMenu} —`, value: "" }, ...collections.map((c) => ({ label: c.title || c.handle, value: c.id }))]} value={itemForm.collection_id || ""} onChange={(v) => setItemForm((p) => ({ ...p, collection_id: v }))} />
        )}
        {itemForm.link_type === "product" && (
          <div style={{ minWidth: 280, flex: 1 }}>
            <SearchableSelect
              label="Product"
              labelHidden
              options={(products || []).map((p) => ({ label: p.title || p.handle, value: p.id, sublabel: p.metadata?.ean || p.sku || "" }))}
              value={itemForm.product_id || ""}
              onChange={(v) => setItemForm((p) => ({ ...p, product_id: v }))}
              placeholder="Search by title, SKU or EAN…"
            />
          </div>
        )}
        {itemForm.link_type === "page" && (
          <div style={{ minWidth: 280, flex: 1 }}>
            <SearchableSelect
              label="Page"
              labelHidden
              options={(pages || []).filter((pg) => pg.page_type !== "blog").map((pg) => ({ label: pg.title || pg.slug, value: String(pg.id) }))}
              value={itemForm.page_id || ""}
              onChange={(v) => setItemForm((p) => ({ ...p, page_id: v }))}
            />
          </div>
        )}
        {itemForm.link_type === "blog_post" && (
          <div style={{ minWidth: 280, flex: 1 }}>
            <SearchableSelect
              label="Blog post"
              labelHidden
              options={(pages || []).filter((pg) => pg.page_type === "blog").map((pg) => ({ label: pg.title || pg.slug, value: String(pg.id) }))}
              value={itemForm.blog_post_id || ""}
              onChange={(v) => setItemForm((p) => ({ ...p, blog_post_id: v }))}
            />
          </div>
        )}
        {itemForm.link_type === "api" && (
          <Select
            label="API function"
            labelHidden
            options={apiFunctionOptions}
            value={itemForm.api_function || "brand"}
            onChange={(v) => setItemForm((p) => ({ ...p, api_function: v }))}
          />
        )}
        {(itemForm.link_type === "url" || itemForm.link_type === "policy" || itemForm.link_type === "blog") && (
          <TextField label="URL/Path" value={itemForm.link_value} onChange={(v) => setItemForm((p) => ({ ...p, link_value: v }))} placeholder={itemForm.link_type === "url" ? "https://…" : "/path"} labelHidden />
        )}
      </div>
      <InlineStack gap="100">
        <Button size="slim" variant="primary" onClick={onSave} loading={saving} accessibilityLabel={menusCopy.save} icon={CheckIcon} />
        <Button size="slim" variant="plain" tone="critical" onClick={onCancel} accessibilityLabel={menusCopy.cancel} icon={DeleteIcon} />
      </InlineStack>
    </div>
  );
}

export default function ContentMenusPage({ panelMode = null, panelMenuId = null }) {
  const locale = useLocale();
  const c = getContentMenusCopy(locale);
  const LINK_TYPES = linkTypesForLocale(locale);
  const API_FUNCTION_OPTIONS = apiFunctionOptionsForLocale(locale);
  const router = useRouter();
  const unsaved = useUnsavedChanges();
  const menuSaveRef = useRef(null);
  const menuDiscardRef = useRef(null);
  const [menus, setMenus] = useState([]);
  const [selectedMenuId, setSelectedMenuId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // This page has many independent save/delete/move actions, several of which fire
  // while a Modal is open (hiding the page-level Banner behind the overlay) or after
  // the user has scrolled down a long menu — a viewport-fixed toast mirrors every
  // error here in one place instead of adding showToast() to each call site.
  useEffect(() => {
    if (error) showToast(error, { error: true });
  }, [error]);
  const [menuModalOpen, setMenuModalOpen] = useState(false);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null);
  const [editingItemId, setEditingItemId] = useState(null);
  const [addUnderParentId, setAddUnderParentId] = useState(null);
  const [collections, setCollections] = useState([]);
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [pages, setPages] = useState([]);
  const [menuForm, setMenuForm] = useState({ name: "", slug: "", location: "main" });
  const [menuSlugManuallyEdited, setMenuSlugManuallyEdited] = useState(false);
  const [itemForm, setItemForm] = useState({
    label: "",
    label_i18n: {},
    slug: "",
    link_type: "url",
    link_value: "",
    parent_id: "",
    category_id: "",
    collection_id: "",
    product_id: "",
    page_id: "",
    custom_slug: "",
    api_function: "brand",
  });
  const [saving, setSaving] = useState(false);
  const [popoverActiveId, setPopoverActiveId] = useState(null);
  const [draggedItemId, setDraggedItemId] = useState(null);
  const [dropTarget, setDropTarget] = useState(() => ({ type: null, id: null })); // { type: 'top'|'above'|'below'|'child', id }
  const [inlineEditingId, setInlineEditingId] = useState(null);
  const [inlineNewOpen, setInlineNewOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [importCsvOpen, setImportCsvOpen] = useState(false);
  const [importCsvFile, setImportCsvFile] = useState(null);
  const [importUnderParentId, setImportUnderParentId] = useState("");
  const [importProgress, setImportProgress] = useState(null); // { total, done, error } | null
  const [menuLocations, setMenuLocations] = useState([]);
  const [editLang, setEditLang] = useState("de");
  const dragJustEndedRef = useRef(false);
  const lastDropTimeRef = useRef(0);
  const hasInitializedExpandedRef = useRef(false);
  const client = getMedusaAdminClient();
  const showPanel = panelMode === "new" || (panelMode === "edit" && panelMenuId);
  const panelMenu = panelMode === "edit" && panelMenuId ? menus.find((m) => m.id === panelMenuId) : null;

  const locationOptions = menuLocations.length > 0
    ? menuLocations.map((loc) => ({ label: loc.label, value: loc.slug }))
    : [
        { label: "Main menu (dropdown by search)", value: "main" },
        { label: "Second menu (navbar bar)", value: "second" },
        { label: "Footer column 1", value: "footer1" },
        { label: "Footer column 2", value: "footer2" },
        { label: "Footer column 3", value: "footer3" },
        { label: "Footer column 4", value: "footer4" },
      ];

  const assignMenuToLocation = async (locationSlug, menuId) => {
    // Find previous menu at this location — match exact slug, empty string treated as unassigned (not as "main")
    const prev = menus.find((m) => m.location === String(locationSlug).toLowerCase());
    try {
      setError(null);
      // Clear previous menu's location using null (empty string causes it to be misread as "main")
      if (prev && prev.id !== menuId) await client.updateMenu(prev.id, { name: prev.name, slug: prev.slug, location: null });
      if (menuId) {
        const menu = menus.find((m) => m.id === menuId);
        if (menu) await client.updateMenu(menuId, { name: menu.name, slug: menu.slug, location: locationSlug });
      }
      await fetchMenus();
    } catch (err) {
      setError(err?.message || "Failed to update assignment");
    }
  };

  const fetchMenus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await client.getMenus();
      const list = data.menus || [];
      setMenus(list);
      const isOnDetailPage = panelMode === "edit" && panelMenuId;
      if (!selectedMenuId && list.length > 0 && !isOnDetailPage) {
        const secondMenu = list.find((m) => (m.location || "").toLowerCase() === "second");
        setSelectedMenuId(secondMenu ? secondMenu.id : list[0].id);
      }
    } catch (err) {
      setError(err?.message || "Failed to load menus");
      setMenus([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchItems = useCallback(async (menuId) => {
    if (!menuId) {
      setItems([]);
      return;
    }
    try {
      const data = await client.getMenuItems(menuId);
      setItems((prev) => {
        return (currentMenuIdRef.current === menuId ? (data.items || []) : prev);
      });
    } catch {
      // Don't clear items on fetch error so saved items don't disappear
    }
  }, []);

  const currentMenuIdRef = useRef(selectedMenuId);
  currentMenuIdRef.current = selectedMenuId;

  const onMenuSaved = useCallback(async (menuId) => {
    currentMenuIdRef.current = menuId;
    await fetchItems(menuId);
  }, [fetchItems]);

  useEffect(() => {
    fetchMenus();
  }, []);
  useEffect(() => {
    client.getMenuLocations().then((data) => setMenuLocations(data.locations || [])).catch(() => setMenuLocations([]));
  }, [client]);

  const effectiveMenuId = showPanel ? (panelMode === "edit" && panelMenuId ? panelMenuId : null) : selectedMenuId;
  useEffect(() => {
    if (panelMode === "edit" && panelMenuId) setSelectedMenuId(panelMenuId);
  }, [panelMode, panelMenuId]);
  useEffect(() => {
    if (!selectedMenuId) {
      setItems([]);
      return;
    }
    hasInitializedExpandedRef.current = false; // Reset so new menu gets fresh expand state
    setItems([]); // Clear immediately so we don't show another menu's items
    fetchItems(selectedMenuId);
  }, [selectedMenuId, fetchItems]);

  useEffect(() => {
    if (items.length > 0 && !hasInitializedExpandedRef.current) {
      const tree = buildMenuTree(items);
      const ids = new Set();
      tree.forEach((n) => { if (n.children?.length) ids.add(n.id); });
      setExpandedIds(ids);
      hasInitializedExpandedRef.current = true;
    }
  }, [items]);

  useEffect(() => {
    client.getMedusaCollections({ adminHub: true }).then((r) => setCollections(r.collections || [])).catch(() => setCollections([]));
    client.getAdminHubCategories().then((r) => setCategories(r.categories || [])).catch(() => setCategories([]));
    client.getAdminHubProducts().then((r) => {
      const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setProducts(list);
    }).catch(() => setProducts([]));
    client.request("/admin-hub/v1/pages").then((r) => setPages(Array.isArray(r?.pages) ? r.pages : [])).catch(() => setPages([]));
  }, []);

  const selectedMenu = menus.find((m) => m.id === selectedMenuId);
  const flatItems = flattenMenuTree(buildMenuTree(items));

  const openAddMenu = () => {
    router.push("/content/menus/new");
  };

  const openEditMenu = (e, menu) => {
    e?.stopPropagation?.();
    router.push(`/content/menus/${menu.id}`);
  };

  const handleMenuNameChange = (value) => {
    setMenuForm((prev) => ({
      ...prev,
      name: value,
      slug: menuSlugManuallyEdited ? prev.slug : slugFromName(value),
    }));
  };

  const handleSaveMenu = async () => {
    const name = (menuForm.name || "").trim();
    const slug = (menuForm.slug || slugFromName(name)).trim();
    if (!name || !slug) {
      setError("Name and slug required");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const location = menuForm.location || "main";
      if (editingMenuId) {
        await client.updateMenu(editingMenuId, { name, slug, location });
      } else {
        await client.createMenu({ name, slug, location });
      }
      setMenuModalOpen(false);
      setEditingMenuId(null);
      await fetchMenus();
    } catch (err) {
      setError(err?.message || (editingMenuId ? "Failed to update menu" : "Failed to create menu"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMenu = async (e, menu) => {
    e?.stopPropagation?.();
    if (!(await confirmDelete(c.deleteMenuConfirmMessage(menu.name || "")))) return;
    try {
      setError(null);
      client.deleteMenu(menu.id).then(() => {
        if (selectedMenuId === menu.id) setSelectedMenuId(menus.find((m) => m.id !== menu.id)?.id || null);
        fetchMenus();
        if (showPanel && panelMenuId === menu.id) router.push("/content/menus");
      });
    } catch (err) {
      setError(err?.message || "Failed to delete menu");
    }
  };

  const handleDuplicateMenu = async (menu) => {
    try {
      setError(null);
      setSaving(true);
      const created = await client.createMenu({
        name: (menu.name || "").trim() ? `Copy of ${menu.name}` : "Copy of menu",
        slug: slugFromName(menu.name || "") ? `${slugFromName(menu.name)}-copy` : "menu-copy",
        location: "main",
      });
      const data = await client.getMenuItems(menu.id);
      const tree = buildMenuTree(data.items || []);
      const flat = flattenMenuTree(tree);
      const oldToNewId = new Map();
      for (const it of flat) {
        const newParentId = it.parent_id ? oldToNewId.get(it.parent_id) ?? null : null;
        const newItem = await client.createMenuItem(created.id, {
          label: it.label || "",
          link_type: it.link_type || "url",
          link_value: it.link_value ?? null,
          parent_id: newParentId,
          sort_order: it.sort_order ?? 0,
        });
        if (newItem && newItem.id) oldToNewId.set(it.id, newItem.id);
      }
      await fetchMenus();
      router.push(`/content/menus/${created.id}`);
    } catch (err) {
      setError(err?.message || "Failed to duplicate menu");
    } finally {
      setSaving(false);
    }
  };

  const closePanel = () => {
    router.push("/content/menus");
  };

  const openAddItem = (parentId = null) => {
    setEditingItemId(null);
    setAddUnderParentId(parentId || null);
    setItemForm({
      label: "",
      label_i18n: {},
      slug: "",
      link_type: "url",
      link_value: "",
      parent_id: parentId || "",
      category_id: "",
      collection_id: "",
      product_id: "",
      page_id: "",
      custom_slug: "",
      api_function: "brand",
    });
    setItemModalOpen(true);
  };

  const openEditItem = (item) => {
    setEditingItemId(item.id);
    setAddUnderParentId(null);
    let category_id = "";
    let collection_id = "";
    let product_id = "";
    let page_id = "";
    if (item.link_type === "category" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        if (v && v.id) category_id = String(v.id);
      } catch (_) {}
    }
    if (item.link_type === "collection" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        if (v && v.id) collection_id = v.id;
      } catch (_) {}
    }
    if (item.link_type === "product" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        if (v && v.id) product_id = v.id;
      } catch (_) {}
    }
    let custom_slug = "";
    if (item.link_type === "page" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        if (v && v.id) page_id = String(v.id);
        if (v && v.label_slug) custom_slug = v.label_slug;
      } catch (_) {}
    }
    let blog_post_id = "";
    if (item.link_type === "blog_post" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        if (v && v.id) blog_post_id = String(v.id);
      } catch (_) {}
    }
    let api_function = "brand";
    if (item.link_type === "api" && item.link_value) {
      try {
        const v = JSON.parse(item.link_value);
        api_function = v?.function || v?.api_function || "brand";
      } catch (_) {}
    }
    setItemForm({
      label: item.label || "",
      label_i18n: item.label_i18n || {},
      slug: item.slug || custom_slug || normalizeItemSlug(item.label || ""),
      link_type: item.link_type || "url",
      link_value: item.link_type === "url" || item.link_type === "policy" || item.link_type === "blog" ? (item.link_value || "") : "",
      parent_id: item.parent_id || "",
      category_id,
      collection_id,
      product_id,
      page_id,
      blog_post_id,
      custom_slug,
      api_function,
    });
    setItemModalOpen(true);
  };

  const handleDeleteItem = async (item) => {
    if (!(await confirmDelete(c.removeItemConfirmMessage(item.label || "")))) return;
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId) return;
    setError(null);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    try {
      await client.deleteMenuItem(menuId, item.id);
      currentMenuIdRef.current = menuId;
      await fetchItems(menuId);
    } catch (err) {
      setError(err?.message || "Failed to remove item");
      currentMenuIdRef.current = menuId;
      await fetchItems(menuId);
    }
  };

  const getLinkDisplay = (item) => {
    if (!item.link_type || item.link_type === "url") return item.link_value || "—";
    if (item.link_type === "api") {
      try {
        const v = typeof item.link_value === "string" ? JSON.parse(item.link_value) : item.link_value;
        const fn = v?.function || v?.api_function || "brand";
        return `API: ${fn}`;
      } catch {
        return "API";
      }
    }
    try {
      const v = typeof item.link_value === "string" ? JSON.parse(item.link_value) : item.link_value;
      if (v && v.title) return v.title;
      if (v && v.handle) return v.handle;
      return item.link_value || "—";
    } catch {
      return item.link_value || "—";
    }
  };

  const handleSaveItem = async () => {
    const label = (itemForm.label || "").trim();
    if (!label) {
      setError("Label required");
      return;
    }
    const itemSlug = normalizeItemSlug(itemForm.slug || label);
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId) return;
    let link_value = itemForm.link_value;
    if (itemForm.link_type === "category" && itemForm.category_id) {
      const cat = findCategoryById(categories, itemForm.category_id);
      const slug = (cat?.slug || "").trim();
      link_value = JSON.stringify({
        id: cat?.id,
        title: cat?.name || cat?.title,
        slug,
        handle: slug,
      });
    } else if (itemForm.link_type === "collection" && itemForm.collection_id) {
      const c = collections.find((x) => x.id === itemForm.collection_id);
      link_value = JSON.stringify({ id: c?.id, title: c?.title, handle: c?.handle });
    } else if (itemForm.link_type === "product" && itemForm.product_id) {
      const p = products.find((x) => x.id === itemForm.product_id);
      link_value = JSON.stringify({ id: p?.id, title: p?.title, handle: p?.handle });
    } else if (itemForm.link_type === "page" && itemForm.page_id) {
      const pg = pages.find((x) => String(x.id) === itemForm.page_id);
      const labelSlug = normalizeItemSlug(itemForm.custom_slug || itemSlug || label);
      link_value = JSON.stringify({ id: pg?.id, title: pg?.title, slug: pg?.slug, label_slug: labelSlug });
    } else if (itemForm.link_type === "blog_post" && itemForm.blog_post_id) {
      const post = pages.find((x) => String(x.id) === itemForm.blog_post_id);
      link_value = JSON.stringify({ id: post?.id, title: post?.title, slug: post?.slug });
    } else if (itemForm.link_type === "api") {
      link_value = JSON.stringify({ function: itemForm.api_function || "brand" });
    } else if (itemForm.link_type !== "url") {
      link_value = itemForm.link_value || "";
    }
    try {
      setSaving(true);
      setError(null);
      if (editingItemId) {
        await client.updateMenuItem(menuId, editingItemId, {
          label: itemForm.label,
          label_i18n: itemForm.label_i18n || null,
          slug: itemSlug,
          link_type: itemForm.link_type || "url",
          link_value: link_value || null,
          parent_id: itemForm.parent_id || null,
        });
      } else {
        const created = await client.createMenuItem(menuId, {
          label: itemForm.label,
          label_i18n: itemForm.label_i18n || null,
          slug: itemSlug,
          link_type: itemForm.link_type || "url",
          link_value: link_value || null,
          parent_id: itemForm.parent_id != null && itemForm.parent_id !== "" ? String(itemForm.parent_id) : null,
        });
        if (created && currentMenuIdRef.current === menuId) {
          setItems((prev) => [...prev, { ...created, sort_order: created.sort_order ?? prev.length }]);
        }
      }
      setItemModalOpen(false);
      setEditingItemId(null);
      setAddUnderParentId(null);
      await fetchItems(menuId);
    } catch (err) {
      setError(err?.message || (editingItemId ? "Failed to update item" : "Failed to add item"));
    } finally {
      setSaving(false);
    }
  };

  const parentOptionsForForm = () => {
    const excludeId = editingItemId || null;
    const opts = [{ label: "— None (top level) —", value: "" }];
    flatItems.forEach(({ id, label, _level }) => {
      if (id === excludeId) return;
      opts.push({ label: "  ".repeat(_level) + (_level ? "? " : "") + (label || id), value: id });
    });
    return opts;
  };

  const getNextSortOrder = useCallback((parentId) => {
    const sameParent = items.filter((i) => (i.parent_id || null) === (parentId || null));
    if (sameParent.length === 0) return 0;
    return Math.max(...sameParent.map((i) => i.sort_order ?? 0)) + 1;
  }, [items]);

  const handleMoveItem = useCallback(async (itemId, newParentId, newSortOrder) => {
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId) return;
    try {
      setError(null);
      await client.updateMenuItem(menuId, itemId, {
        parent_id: newParentId || null,
        sort_order: newSortOrder,
      });
      await fetchItems(menuId);
    } catch (err) {
      setError(err?.message || "Failed to move item");
    } finally {
      setDraggedItemId(null);
      setDropTarget({ type: null, id: null });
    }
  }, [effectiveMenuId, selectedMenuId, client]);

  const handleMoveItemBetween = useCallback(async (draggedId, targetRow, zone) => {
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId) return;
    try {
      setError(null);
      const newParentId = targetRow.parent_id || null;
      const siblings = items
        .filter((i) => (i.parent_id || null) === newParentId && i.id !== draggedId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id)));
      const targetIndex = siblings.findIndex((r) => String(r.id) === String(targetRow.id));
      const insertIndex = zone === "above" ? targetIndex : targetIndex + 1;
      const orderedIds = [...siblings.map((r) => r.id)];
      orderedIds.splice(insertIndex, 0, draggedId);
      await client.updateMenuItem(menuId, draggedId, { parent_id: newParentId, sort_order: 0 });
      for (let i = 0; i < orderedIds.length; i++) {
        await client.updateMenuItem(menuId, orderedIds[i], { sort_order: i });
      }
      await fetchItems(menuId);
    } catch (err) {
      setError(err?.message || "Failed to move item");
    } finally {
      setDraggedItemId(null);
      setDropTarget({ type: null, id: null });
    }
  }, [effectiveMenuId, selectedMenuId, client, items]);

  const onDragStart = (e, itemId) => {
    setDraggedItemId(itemId);
    dragJustEndedRef.current = true;
    e.dataTransfer.setData("text/plain", String(itemId));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e, payload) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (payload && typeof payload === "object" && payload.type && typeof setDropTarget === "function") {
      setDropTarget({ type: payload.type, id: payload.id ?? null });
    }
  };

  const onDragLeave = () => {
    setDropTarget({ type: null, id: null });
  };

  const runImportCsv = async () => {
    const menuId = effectiveMenuId ?? selectedMenuId;
    if (!menuId || !importCsvFile) return;
    const file = importCsvFile;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setImportProgress({ total: 0, done: 0, error: err?.message || "Could not read file" });
      return;
    }
    const list = parseCategoriesCsvToCreateList(text);
    if (list.length === 0) {
      setImportProgress({ total: 0, done: 0, error: "No categories found in CSV. Use semicolon-separated columns (e.g. Main Category;Subcategory 1;...)." });
      return;
    }
    setImportProgress({ total: list.length, done: 0, error: null });
    const createdIds = new Map(); // key -> menu item id
    const rootParentId = importUnderParentId && String(importUnderParentId).trim() ? String(importUnderParentId) : null;
    try {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const parentId = item.parentKey === "" ? rootParentId : (createdIds.get(item.parentKey) ?? null);
        const created = await client.createMenuItem(menuId, {
          label: item.label,
          link_type: "url",
          link_value: null,
          parent_id: parentId,
          sort_order: item.sortOrder,
        });
        if (created?.id) createdIds.set(item.key, created.id);
        setImportProgress((prev) => prev ? { ...prev, done: i + 1 } : { total: list.length, done: i + 1, error: null });
      }
      await fetchItems(menuId);
      setImportCsvOpen(false);
      setImportCsvFile(null);
      setImportUnderParentId("");
      setImportProgress(null);
    } catch (err) {
      setImportProgress((prev) => ({
        ...(prev || { total: list.length, done: 0 }),
        done: prev?.done ?? 0,
        error: err?.message || "Import failed",
      }));
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const itemId = draggedItemId || e.dataTransfer.getData("text/plain");
    if (!itemId) return;
    const { type, id } = dropTarget || {};
    if (type === "top" || !type) {
      handleMoveItem(itemId, null, getNextSortOrder(null));
    } else if ((type === "above" || type === "below") && id) {
      const row = flatItems.find((r) => String(r.id) === String(id));
      if (row) handleMoveItemBetween(itemId, row, type);
    } else if (type === "child" && id) {
      handleMoveItem(itemId, id, getNextSortOrder(id));
    }
    setDraggedItemId(null);
    setDropTarget({ type: null, id: null });
    dragJustEndedRef.current = true;
    lastDropTimeRef.current = Date.now();
    setTimeout(() => { dragJustEndedRef.current = false; }, 500);
  };

  const onDragEnd = () => {
    setDraggedItemId(null);
    setDropTarget({ type: null, id: null });
    dragJustEndedRef.current = true;
    lastDropTimeRef.current = Date.now();
    setTimeout(() => { dragJustEndedRef.current = false; }, 500);
  };

  const isClickAfterDrag = () => {
    if (dragJustEndedRef.current) return true;
    if (Date.now() - lastDropTimeRef.current < 500) return true;
    return false;
  };

  // Detail page: /content/menus/[id] or /content/menus/new – show editor as full page (no overlay)
  if (showPanel) {
    return (
      <Page
        title={panelMode === "new" ? "New menu" : (panelMenu?.name || "Menu")}
        backAction={{ content: "Menus", onAction: closePanel }}
        primaryAction={
          panelMode === "new"
            ? undefined
            : {
                content: "Create menu",
                icon: PlusIcon,
                onAction: openAddMenu,
              }
        }
        secondaryActions={[{ content: "URL redirects", url: "/content/url-redirects" }]}
      >
        <Layout>
          {error && (
            <Layout.Section>
              <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
            </Layout.Section>
          )}
          <Layout.Section>
            <Card>
              <MenuEditorPanel
              uiLocale={locale}
              editLang={editLang}
              setEditLang={setEditLang}
              panelMode={panelMode}
              panelMenuId={panelMenuId}
              selectedMenuId={selectedMenuId}
              panelMenu={panelMenu}
              menuForm={menuForm}
              setMenuForm={setMenuForm}
              menuSlugManuallyEdited={menuSlugManuallyEdited}
              setMenuSlugManuallyEdited={setMenuSlugManuallyEdited}
              handleMenuNameChange={handleMenuNameChange}
              slugFromName={slugFromName}
              items={items}
              flatItems={flatItems}
              effectiveMenuId={effectiveMenuId}
              fetchMenus={fetchMenus}
              fetchItems={fetchItems}
              closePanel={closePanel}
              handleDuplicateMenu={handleDuplicateMenu}
              handleDeleteMenu={handleDeleteMenu}
              setError={setError}
              saving={saving}
              setSaving={setSaving}
              client={client}
              collections={collections}
              categories={categories}
              products={products}
              pages={pages}
              LINK_TYPES={LINK_TYPES}
              API_FUNCTION_OPTIONS={API_FUNCTION_OPTIONS}
              menusCopy={c}
              getLinkDisplay={getLinkDisplay}
              TAB_SIZE={TAB_SIZE}
              buildMenuTree={buildMenuTree}
              flattenMenuTree={flattenMenuTree}
              getNextSortOrder={getNextSortOrder}
              handleMoveItem={handleMoveItem}
              handleDeleteItem={handleDeleteItem}
              draggedItemId={draggedItemId}
              dropTarget={dropTarget}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              dragJustEndedRef={dragJustEndedRef}
              isClickAfterDrag={isClickAfterDrag}
              popoverActiveId={popoverActiveId}
              setPopoverActiveId={setPopoverActiveId}
              inlineEditingId={inlineEditingId}
              setInlineEditingId={setInlineEditingId}
              inlineNewOpen={inlineNewOpen}
              setInlineNewOpen={setInlineNewOpen}
              itemForm={itemForm}
              setItemForm={setItemForm}
              editingItemId={editingItemId}
              setEditingItemId={setEditingItemId}
              addUnderParentId={addUnderParentId}
              setAddUnderParentId={setAddUnderParentId}
              openAddItem={openAddItem}
              openEditItem={openEditItem}
              handleSaveItem={handleSaveItem}
              parentOptionsForForm={parentOptionsForForm}
    expandedIds={expandedIds}
    setExpandedIds={setExpandedIds}
    router={router}
    onOpenImportCsv={() => setImportCsvOpen(true)}
    onMenuSaved={onMenuSaved}
    locationOptions={locationOptions}
    onDirtyChange={(dirty, handlers) => {
      if (!unsaved) return;
      unsaved.setDirty(!!dirty);
      if (dirty && handlers) {
        menuSaveRef.current = handlers.save;
        menuDiscardRef.current = handlers.discard;
        unsaved.setHandlers({
          onSave: () => menuSaveRef.current?.(),
          onDiscard: () => menuDiscardRef.current?.(),
        });
      } else if (!dirty) {
        menuSaveRef.current = null;
        menuDiscardRef.current = null;
        unsaved.clearHandlers();
      }
    }}
  />
              </Card>
            </Layout.Section>
          </Layout>
          <Modal
            open={importCsvOpen}
            onClose={() => {
              if (!importProgress || importProgress.error || importProgress.done >= importProgress.total) {
                setImportCsvOpen(false);
                setImportCsvFile(null);
                setImportUnderParentId("");
                setImportProgress(null);
              }
            }}
            title="Import categories from CSV"
            primaryAction={{
              content: "Import",
              onAction: runImportCsv,
              loading: importProgress != null && !importProgress.error && importProgress.done < importProgress.total,
            }}
          >
            <Modal.Section>
              <BlockStack gap="400">
                <Text as="p" tone="subdued">
                  Upload a semicolon-separated CSV with columns like: Main Category;Subcategory 1;Subcategory 2;… Hierarchy is built from the columns; duplicate branches are merged.
                </Text>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <Text as="span" variant="bodyMd" fontWeight="medium">CSV file</Text>
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      setImportCsvFile(f || null);
                      if (!f) setImportProgress(null);
                    }}
                  />
                </label>
                <Select
                  label="Add under"
                  options={[
                    { label: "Top level", value: "" },
                    ...flatItems.map(({ id, label, _level }) => ({
                      label: "  ".repeat(_level) + (_level ? "? " : "") + (label || id),
                      value: id,
                    })),
                  ]}
                  value={importUnderParentId}
                  onChange={setImportUnderParentId}
                />
                {importProgress != null && (
                  <BlockStack gap="200">
                    {importProgress.error ? (
                      <Banner tone="critical" onDismiss={() => setImportProgress(null)}>{importProgress.error}</Banner>
                    ) : (
                      <Text as="p" variant="bodyMd">Imported {importProgress.done} / {importProgress.total} items.</Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Modal.Section>
          </Modal>
        </Page>
      );
  }

  // List page: /content/menus – only Menus list + Menu items placeholder
  return (
    <Page
      title={c.pageTitle}
      primaryAction={{
        content: c.createMenu,
        icon: PlusIcon,
        onAction: openAddMenu,
      }}
      secondaryActions={[{ content: "URL redirects", url: "/content/url-redirects" }]}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card>
            <BlockStack gap="600">
              <Text as="h2" variant="headingMd" fontWeight="bold">{c.pageTitle}</Text>
              {loading ? (
                <Box paddingBlock="400">
                  <Text as="p" tone="subdued">{c.loading}</Text>
                </Box>
              ) : menus.length === 0 ? (
                <EmptyState
                  heading={c.noMenus}
                  action={{ content: c.createMenu, onAction: openAddMenu }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Menus group navigation links. Create a menu, then click it to add items and submenus.</p>
                </EmptyState>
              ) : (
                <div style={{ border: "1px solid var(--p-color-border-subdued)", borderRadius: "12px", overflow: "hidden", background: "var(--p-color-bg-surface)" }}>
                  {menus.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 20px",
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                        gap: "12px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => router.push(`/content/menus/${m.id}`)}
                        style={{
                          flex: 1,
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          font: "inherit",
                          color: "var(--p-color-text)",
                          fontWeight: 500,
                        }}
                      >
                        {m.name}
                      </button>
                      <InlineStack gap="100" wrap={false}>
                        <Button size="slim" variant="plain" tone="subdued" accessibilityLabel="Edit" icon={EditIcon} onClick={(e) => { e.stopPropagation(); router.push(`/content/menus/${m.id}`); }} />
                        <Button size="slim" variant="plain" tone="critical" accessibilityLabel="Delete" icon={DeleteIcon} onClick={(e) => handleDeleteMenu(e, m)} />
                      </InlineStack>
                    </div>
                  ))}
                </div>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd" fontWeight="bold">Where menus appear</Text>
              <Text as="p" tone="subdued">Assign a menu to each location. Changing here updates the menu’s location; changing a menu’s location in the editor is reflected here.</Text>
              <div style={{ border: "1px solid var(--p-color-border-subdued)", borderRadius: "12px", overflow: "hidden", background: "var(--p-color-bg-surface)" }}>
                {locationOptions.map((loc) => {
                  const assignedMenuId = menus.find((m) => (m.location || "").toLowerCase() === String(loc.value).toLowerCase())?.id ?? "";
                  return (
                    <div
                      key={loc.value}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 20px",
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                        gap: "16px",
                        flexWrap: "wrap",
                      }}
                    >
                      <Text as="span" variant="bodyMd" fontWeight="medium">{loc.label}</Text>
                      <div style={{ minWidth: 220 }}>
                        <Select
                          label=""
                          labelHidden
                          options={[
                            { label: "— None —", value: "" },
                            ...menus.map((m) => ({ label: m.name, value: m.id })),
                          ]}
                          value={assignedMenuId}
                          onChange={(value) => assignMenuToLocation(loc.value, value || null)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Legacy modals (for menu name edit when not using panel – keep for fallback) */}
      <Modal
        open={menuModalOpen}
        onClose={() => !saving && setMenuModalOpen(false)}
        title={editingMenuId ? "Edit menu" : "Add menu"}
        primaryAction={{
          content: saving ? (editingMenuId ? "Saving…" : "Creating…") : (editingMenuId ? "Save" : "Create"),
          onAction: handleSaveMenu,
          loading: saving,
        }}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Menu name"
              value={menuForm.name}
              onChange={handleMenuNameChange}
              placeholder="e.g. Main menu"
              autoComplete="off"
            />
            <TextField
              label="Slug"
              value={menuForm.slug}
              onChange={(value) => {
                setMenuSlugManuallyEdited(true);
                setMenuForm((prev) => ({ ...prev, slug: value }));
              }}
              placeholder="e.g. main-menu"
              autoComplete="off"
              helpText="Used in the store (e.g. main-menu). Auto-filled from name."
            />
            <Select
              label="Location"
              options={locationOptions || []}
              value={menuForm.location || "main"}
              onChange={(value) => setMenuForm((prev) => ({ ...prev, location: value }))}
              helpText="Where this menu appears. Locations are defined in the database and linked to the store (e.g. subnav bar)."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        key={`item-modal-${editingItemId ?? "new"}`}
        open={itemModalOpen}
        onClose={() => !saving && (setItemModalOpen(false), setAddUnderParentId(null))}
        title={editingItemId ? "Edit menu item" : addUnderParentId ? "Add submenu item" : "Add menu item"}
        primaryAction={{
          content: saving ? (editingItemId ? "Saving…" : "Adding…") : (editingItemId ? "Save" : "Add"),
          onAction: handleSaveItem,
          loading: saving,
        }}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Label (text shown in menu)"
              value={itemForm.label}
              onChange={(value) => setItemForm((prev) => ({
                ...prev,
                label: value,
                slug: prev.slug === normalizeItemSlug(prev.label || "") || !prev.slug ? normalizeItemSlug(value) : prev.slug,
                custom_slug: prev.custom_slug === normalizeItemSlug(prev.label || "") || !prev.custom_slug ? normalizeItemSlug(value) : prev.custom_slug,
              }))}
              placeholder="e.g. Sale"
              autoComplete="off"
            />
            <TextField
              label="Slug"
              value={itemForm.slug || ""}
              onChange={(value) => setItemForm((prev) => ({ ...prev, slug: normalizeItemSlug(value), custom_slug: prev.link_type === "page" ? normalizeItemSlug(value) : prev.custom_slug }))}
              placeholder={normalizeItemSlug(itemForm.label) || "e.g. sale"}
              autoComplete="off"
              helpText="Saved directly on the menu item."
            />
            <Select
              label="Link type"
              options={LINK_TYPES}
              value={itemForm.link_type}
              onChange={(value) => setItemForm((prev) => ({ ...prev, link_type: value }))}
            />
            {itemForm.link_type === "category" && (
              <CategoryDrilldownSelect
                label="Category"
                categories={categories || []}
                value={itemForm.category_id || ""}
                onChange={(value) => setItemForm((prev) => ({ ...prev, category_id: value }))}
                placeholder="Select category"
                noneLabel="— Select category —"
              />
            )}
            {itemForm.link_type === "collection" && (
              <Select
                label="Collection"
                labelHidden
                options={[
                  { label: "— Select collection —", value: "" },
                  ...collections.map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
                ]}
                value={itemForm.collection_id || ""}
                onChange={(value) => setItemForm((prev) => ({ ...prev, collection_id: value }))}
              />
            )}
            {itemForm.link_type === "product" && (
              <Select
                label="Product"
                labelHidden
                options={[
                  { label: "— Select product —", value: "" },
                  ...(products || []).map((p) => ({ label: p.title || p.handle || p.id, value: p.id })),
                ]}
                value={itemForm.product_id || ""}
                onChange={(value) => setItemForm((prev) => ({ ...prev, product_id: value }))}
              />
            )}
            {itemForm.link_type === "page" && (
              <>
                <Select
                  label="Page"
                  options={[
                    { label: "— Sayfa seç —", value: "" },
                    ...pages.map((pg) => ({ label: pg.title || pg.slug, value: String(pg.id) })),
                  ]}
                  value={itemForm.page_id || ""}
                  onChange={(value) => setItemForm((prev) => ({ ...prev, page_id: value }))}
                />
                <TextField
                  label="Slug (URL-Pfad)"
                  value={itemForm.custom_slug || itemForm.slug || ""}
                  onChange={(value) => setItemForm((prev) => ({ ...prev, custom_slug: normalizeItemSlug(value), slug: prev.slug || normalizeItemSlug(value) }))}
                  placeholder={normalizeItemSlug(itemForm.label) || "z.B. footer-item-1"}
                  autoComplete="off"
                  helpText="Leer lassen = automatisch aus dem Label generiert"
                />
              </>
            )}
            {itemForm.link_type === "api" && (
              <Select
                label="API function"
                options={API_FUNCTION_OPTIONS}
                value={itemForm.api_function || "brand"}
                onChange={(value) => setItemForm((prev) => ({ ...prev, api_function: value }))}
              />
            )}
            {(itemForm.link_type === "url" || itemForm.link_type === "policy" || itemForm.link_type === "blog" || itemForm.link_type === "blog_post") && (
              <TextField
                label={itemForm.link_type === "url" ? "URL" : "Path or URL"}
                value={itemForm.link_value}
                onChange={(value) => setItemForm((prev) => ({ ...prev, link_value: value }))}
                placeholder={itemForm.link_type === "url" ? "https://…" : "/page or /policy/…"}
                autoComplete="off"
              />
            )}
            {flatItems.length > 0 && (
              <Select
                label="Parent item (for submenu)"
                options={parentOptionsForForm()}
                value={itemForm.parent_id}
                onChange={(value) => setItemForm((prev) => ({ ...prev, parent_id: value }))}
                helpText={addUnderParentId ? "Pre-selected as submenu of the item you clicked + on." : "Choose parent to nest this item under another."}
              />
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
