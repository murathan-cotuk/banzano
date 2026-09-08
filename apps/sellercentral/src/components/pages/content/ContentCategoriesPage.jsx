"use client";

import React, { useState, useEffect } from "react";
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
  Divider,
  Checkbox,
  Modal,
  Select,
  Badge,
} from "@shopify/polaris";
import { EditIcon, DeleteIcon, ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { titleToHandle } from "@/lib/slugify";
import MediaPickerModal from "@/components/MediaPickerModal";
import RichTextEditor from "@/components/RichTextEditor";
import SearchableSelect from "@/components/inputs/SearchableSelect";
import { useLocale } from "next-intl";
import { categoryDisplayName } from "@/lib/category-locale";
import { seoPlainPreview } from "@/lib/product-change-request-format";

function slugFromName(name) {
  return titleToHandle(name || "");
}

/** Parse semicolon-separated hierarchical CSV into a flat create list (key, label, parentKey, sortOrder). */
function parseCategoriesCsvToCreateList(csvText) {
  const lines = (csvText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0];
  const rows = lines.slice(1);
  const separator = header.includes(";") ? ";" : ",";
  const labelMap = {};
  const childrenMap = {};
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
  const createList = [];
  const queue = [""];
  while (queue.length) {
    const parentKey = queue.shift();
    const childKeys = childrenMap[parentKey] || [];
    for (let i = 0; i < childKeys.length; i++) {
      const key = childKeys[i];
      createList.push({ key, label: labelMap[key] || key, parentKey, sortOrder: i });
      queue.push(key);
    }
  }
  return createList;
}

function buildTree(flatList) {
  const byId = new Map(flatList.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of flatList) {
    const node = byId.get(c.id);
    if (!c.parent_id) {
      roots.push(node);
    } else {
      const parent = byId.get(c.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (arr) => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || "").localeCompare(b.name || ""));
  sort(roots);
  roots.forEach((r) => sort(r.children));
  return roots;
}

function TreeNode({ node, depth, onDelete, selectedIds, onToggleSelect, locale }) {
  const [open, setOpen] = useState(false);
  const hasKids = node.children && node.children.length > 0;
  const router = useRouter();

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 16 + depth * 8,
          paddingRight: 16,
          borderBottom: "1px solid #f1f1f1",
          background: depth === 0 ? "#fafafa" : "#fff",
          gap: 8,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "#f6f6f7"; }}
        onMouseLeave={e => { e.currentTarget.style.background = depth === 0 ? "#fafafa" : "#fff"; }}
      >
        {/* chevron */}
        <button
          type="button"
          onClick={() => hasKids && setOpen(v => !v)}
          style={{ background: "none", border: "none", padding: 0, cursor: hasKids ? "pointer" : "default", display: "flex", alignItems: "center", flexShrink: 0, width: 20, height: 20, color: "#637381" }}
        >
          {hasKids ? (open ? <ChevronDownIcon /> : <ChevronRightIcon />) : <span style={{ width: 20 }} />}
        </button>
        <Checkbox
          checked={selectedIds.has(node.id)}
          onChange={(checked) => onToggleSelect(node, checked)}
          label=""
        />

        {/* name */}
        <div style={{ flex: "0 0 240px", minWidth: 0 }}>
          <button
            type="button"
            onClick={() => router.push(`/content/categories/${node.id}`)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            <Text as="span" variant="bodyMd" fontWeight={depth === 0 ? "semibold" : "regular"} tone="magic">
              {categoryDisplayName(node, locale)}
            </Text>
          </button>
          {hasKids && (
            <Text as="span" variant="bodySm" tone="subdued"> ({node.children.length})</Text>
          )}
        </div>

        {/* slug */}
        <div style={{ flex: "0 0 180px", minWidth: 0 }}>
          <Text as="span" variant="bodySm" tone="subdued">/{node.slug}</Text>
        </div>

        {/* collection */}
        <div style={{ flex: "0 0 100px" }}>
          {node.has_collection ? <Badge tone="success">Collection</Badge> : <Text as="span" tone="subdued">—</Text>}
        </div>

        {/* status */}
        <div style={{ flex: "0 0 140px", display: "flex", gap: 6 }}>
          <Badge tone={node.active ? "success" : "critical"}>{node.active ? "Active" : "Inactive"}</Badge>
          {node.is_visible && <Badge>Visible</Badge>}
        </div>

        {/* actions */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <Button size="slim" variant="plain" tone="subdued" accessibilityLabel="Edit" icon={EditIcon} onClick={() => router.push(`/content/categories/${node.id}`)} />
          <Button size="slim" variant="plain" tone="critical" accessibilityLabel="Delete" icon={DeleteIcon} onClick={() => onDelete(node.id)} />
        </div>
      </div>

      {hasKids && open && (
        <div style={{ borderLeft: "3px solid #e5e7eb", marginLeft: 16 + depth * 8 + 20 }}>
          {node.children.map(child => (
            <TreeNode key={child.id} node={child} depth={depth + 1} onDelete={onDelete} selectedIds={selectedIds} onToggleSelect={onToggleSelect} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "";
  return (typeof env === "string" ? env : "").trim() || (typeof window !== "undefined" ? "http://localhost:9000" : "");
};

const emptyForm = {
  name: "",
  slug: "",
  description: "",
  parent_id: "",
  has_collection: false,
  active: true,
  is_visible: true,
  collection_id: "",
  display_title: "",
  meta_title: "",
  meta_description: "",
  keywords: "",
  richtext: "",
  image_url: "",
  banner_image_url: "",
};
const initialSlugTouched = false;

export default function ContentCategoriesPage() {
  const locale = useLocale();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [form, setForm] = useState(emptyForm);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(initialSlugTouched);
  const [medusaCollections, setMedusaCollections] = useState([]);
  const [importCsvOpen, setImportCsvOpen] = useState(false);
  const [importCsvFile, setImportCsvFile] = useState(null);
  const [importProgress, setImportProgress] = useState(null); // { total, done, error } | null
  const [bannerUploading, setBannerUploading] = useState(false);
  const [mainImgPickerOpen, setMainImgPickerOpen] = useState(false);
  const [bannerImgPickerOpen, setBannerImgPickerOpen] = useState(false);
  const client = getMedusaAdminClient();
  const baseUrl = (client.baseURL || getDefaultBaseUrl()).replace(/\/$/, "");

  const fetchCategories = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await client.getAdminHubCategories({ all: true });
      setCategories(data.categories || []);
    } catch (err) {
      setError(err?.message || "Failed to load categories");
      setCategories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  useEffect(() => {
    client.getMedusaCollections({ adminHub: true }).then((r) => setMedusaCollections(r.collections || [])).catch(() => setMedusaCollections([]));
  }, []);

  const handleNameChange = (value) => {
    setForm((prev) => ({
      ...prev,
      name: value,
      slug: slugManuallyEdited ? prev.slug : slugFromName(value),
    }));
  };

  const openCreate = () => {
    setEditId(null);
    setSlugManuallyEdited(false);
    setForm({ ...emptyForm, parent_id: "", image_url: "", banner_image_url: "" });
    setModalOpen(true);
  };

  const openEdit = (cat) => {
    setEditId(cat.id);
    setSlugManuallyEdited(false);
    setForm({
      name: cat.name || "",
      slug: cat.slug || slugFromName(cat.name || ""),
      description: cat.description || "",
      parent_id: cat.parent_id || "",
      has_collection: !!cat.has_collection,
      active: !!cat.active,
      is_visible: !!cat.is_visible,
      collection_id: (cat.metadata && cat.metadata.collection_id) || "",
      display_title: (cat.metadata && cat.metadata.display_title) || "",
      meta_title: cat.seo_title || (cat.metadata && cat.metadata.meta_title) || "",
      meta_description: cat.seo_description || (cat.metadata && cat.metadata.meta_description) || "",
      keywords: (cat.metadata && cat.metadata.keywords) || "",
      richtext: cat.long_content || (cat.metadata && cat.metadata.richtext) || "",
      image_url: (cat.metadata && cat.metadata.image_url) || "",
      banner_image_url: cat.banner_image_url ?? "",
    });
    setModalOpen(true);
  };

  const handleDeleteCategory = async () => {
    if (!deleteId) return;
    try {
      setDeleting(true);
      setError(null);
      await client.deleteAdminHubCategory(deleteId);
      setDeleteId(null);
      await fetchCategories();
    } catch (err) {
      setError(err?.message || "Failed to delete category. Delete or move child categories first.");
    } finally {
      setDeleting(false);
    }
  };

  const collectDescendantIds = (categoryId) => {
    const out = [];
    const queue = [categoryId];
    while (queue.length) {
      const current = queue.shift();
      out.push(current);
      for (const c of categories) {
        if (c.parent_id === current) queue.push(c.id);
      }
    }
    return out;
  };

  const toggleNodeSelection = (node, checked) => {
    const ids = collectDescendantIds(node.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) ids.forEach((id) => next.add(id));
      else ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const bulkSetActive = async (active) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBulkUpdating(true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => client.updateAdminHubCategory(id, { active })));
      setSelectedIds(new Set());
      await fetchCategories();
    } catch (err) {
      setError(err?.message || "Bulk update failed.");
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleSubmit = async () => {
    const name = (form.name || "").trim();
    const slug = (form.slug || slugFromName(name)).trim();
    if (!name || !slug) {
      setError("Name and slug are required.");
      return;
    }
    const payload = {
      name,
      slug,
      description: (form.description || "").trim() || undefined,
      parent_id: form.parent_id || null,
      has_collection: !!form.has_collection,
      active: !!form.active,
      is_visible: !!form.is_visible,
      seo_title: (form.meta_title || "").trim() || null,
      seo_description: (form.meta_description || "").trim() || null,
      long_content: (form.richtext || "").trim() || null,
      banner_image_url: (form.banner_image_url || "").trim() || null,
      metadata: {
        ...(form.collection_id ? { collection_id: form.collection_id } : {}),
        display_title: (form.display_title || "").trim() || null,
        meta_title: (form.meta_title || "").trim() || null,
        meta_description: (form.meta_description || "").trim() || null,
        keywords: (form.keywords || "").trim() || null,
        richtext: (form.richtext || "").trim() || null,
        image_url: (form.image_url || "").trim() || null,
        banner_image_url: (form.banner_image_url || "").trim() || null,
      },
    };

    try {
      if (editId) {
        setSaving(true);
        setError(null);
        await client.updateAdminHubCategory(editId, payload);
        setModalOpen(false);
        await fetchCategories();
      } else {
        setCreating(true);
        setError(null);
        await client.createAdminHubCategory(payload);
        setModalOpen(false);
        setForm(emptyForm);
        await fetchCategories();
      }
    } catch (err) {
      setError(err?.message || (editId ? "Failed to update category" : "Failed to create category"));
    } finally {
      setCreating(false);
      setSaving(false);
    }
  };

  const runImportCsv = async () => {
    if (!importCsvFile) return;
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
      setImportProgress({ total: 0, done: 0, error: "No categories found. Use semicolon-separated columns (e.g. Main Category;Subcategory 1;...)." });
      return;
    }
    setImportProgress({ total: list.length, done: 0, error: null });
    try {
      const result = await client.importAdminHubCategories(list);
      setImportProgress((prev) => ({ ...prev, done: result?.imported ?? list.length, error: null }));
      await fetchCategories();
      setImportCsvOpen(false);
      setImportCsvFile(null);
      setImportProgress(null);
    } catch (err) {
      setImportProgress((prev) => ({
        ...(prev || { total: list.length, done: 0 }),
        error: err?.message || "Import failed",
      }));
    }
  };

  const tree = buildTree(categories);
  const parentOptions = [
    { label: "— None (top level) —", value: "" },
    ...categories
      .filter((c) => !editId || c.id !== editId)
      .map((c) => ({
        label: categoryDisplayName(c, locale),
        value: String(c.id),
        sublabel: c.slug ? `/${c.slug}` : undefined,
      })),
  ];


  return (
    <Page
      title="Categories"
      primaryAction={{
        content: "Add category",
        onAction: openCreate,
      }}
      secondaryActions={[
        {
          content: "Import from CSV",
          onAction: () => setImportCsvOpen(true),
        },
      ]}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingSm">
                  All categories
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  {selectedIds.size > 0 && (
                    <>
                      <Button size="slim" onClick={() => bulkSetActive(true)} loading={bulkUpdating}>
                        Activate selected
                      </Button>
                      <Button size="slim" tone="critical" onClick={() => bulkSetActive(false)} loading={bulkUpdating}>
                        Deactivate selected
                      </Button>
                    </>
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">
                    {categories.length} {categories.length === 1 ? "category" : "categories"}
                  </Text>
                </InlineStack>
              </InlineStack>
              <Divider />

              {loading ? (
                <Box paddingBlock="400">
                  <Text as="p" tone="subdued">
                    Loading…
                  </Text>
                </Box>
              ) : categories.length === 0 ? (
                <Box paddingBlock="400">
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      No categories yet. Add one to use in products and collections.
                    </Text>
                    <Button variant="primary" onClick={openCreate}>
                      Add category
                    </Button>
                  </BlockStack>
                </Box>
              ) : (
                <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
                  {/* header */}
                  <div style={{ display: "flex", alignItems: "center", padding: "8px 16px 8px 60px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5", gap: 8 }}>
                    <div style={{ width: 24 }} />
                    <div style={{ flex: "0 0 240px" }}><Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Name</Text></div>
                    <div style={{ flex: "0 0 180px" }}><Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Slug</Text></div>
                    <div style={{ flex: "0 0 100px" }}><Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Collection</Text></div>
                    <div style={{ flex: "0 0 140px" }}><Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Status</Text></div>
                  </div>
                  {tree.map(node => (
                    <TreeNode key={node.id} node={node} depth={0} onDelete={setDeleteId} selectedIds={selectedIds} onToggleSelect={toggleNodeSelection} locale={locale} />
                  ))}
                </div>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={importCsvOpen}
        onClose={() => {
          if (!importProgress || importProgress.error || importProgress.done >= importProgress.total) {
            setImportCsvOpen(false);
            setImportCsvFile(null);
            setImportProgress(null);
          }
        }}
        title="Import categories from CSV"
        primaryAction={{
          content: importProgress != null && importProgress.done < importProgress.total && !importProgress.error ? "Importing…" : "Import",
          onAction: runImportCsv,
          loading: importProgress != null && !importProgress?.error && importProgress.done < importProgress.total,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              if (!(importProgress != null && importProgress.done < importProgress.total)) {
                setImportCsvOpen(false);
                setImportCsvFile(null);
                setImportProgress(null);
              }
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Upload a semicolon-separated CSV with columns like: Main Category;Subcategory 1;Subcategory 2;… Categories are saved to the same list as panel categories and will appear here.
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
            {importProgress != null && (
              <BlockStack gap="200">
                {importProgress.error ? (
                  <Banner tone="critical" onDismiss={() => setImportProgress(null)}>{importProgress.error}</Banner>
                ) : (
                  <Text as="p" variant="bodyMd">
                    {importProgress.done >= importProgress.total ? `Imported ${importProgress.done} categories.` : `Importing… ${importProgress.done} / ${importProgress.total}`}
                  </Text>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={!!deleteId}
        onClose={() => !deleting && setDeleteId(null)}
        title="Delete category"
        primaryAction={{
          content: deleting ? "Deleting…" : "Delete",
          destructive: true,
          onAction: handleDeleteCategory,
          loading: deleting,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Are you sure you want to delete &quot;{categoryDisplayName(categories.find((c) => c.id === deleteId), locale) || "this category"}&quot;?
            {categories.some((c) => c.parent_id === deleteId) && " This category has subcategories; delete or move them first."}
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => {
          if (!creating && !saving) setModalOpen(false);
        }}
        title={editId ? "Edit category" : "Add category"}
        primaryAction={{
          content: creating || saving ? (editId ? "Saving…" : "Creating…") : editId ? "Save" : "Create",
          onAction: handleSubmit,
          loading: creating || saving,
        }}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <SearchableSelect
              label="Parent category (subcategory)"
              options={parentOptions}
              value={form.parent_id || ""}
              onChange={(value) => setForm((prev) => ({ ...prev, parent_id: value }))}
              emptyLabel="— None (top level) —"
              placeholder="Search parent category…"
            />
            <TextField
              label="Name"
              value={form.name}
              onChange={handleNameChange}
              autoComplete="off"
              placeholder="e.g. Electronics"
            />
            <TextField
              label="Slug"
              value={form.slug}
              onChange={(value) => {
                setSlugManuallyEdited(true);
                setForm((prev) => ({ ...prev, slug: value }));
              }}
              autoComplete="off"
              placeholder="e.g. sports-outdoors"
              helpText="Auto-filled from name (e.g. Sports & Outdoors → sports-outdoors). You can change it."
            />
            <TextField
              label="Description"
              value={form.description}
              onChange={(value) => setForm((prev) => ({ ...prev, description: value }))}
              multiline={2}
              autoComplete="off"
            />
            <TextField
              label="Display title (h1 on category page)"
              value={form.display_title}
              onChange={(value) => setForm((prev) => ({ ...prev, display_title: value }))}
              autoComplete="off"
              placeholder="Optional custom title"
            />
            <TextField
              label="Meta title"
              value={form.meta_title}
              onChange={(value) => setForm((prev) => ({ ...prev, meta_title: value }))}
              autoComplete="off"
              placeholder={form.name || form.display_title || ""}
            />
            <TextField
              label="Meta description"
              value={form.meta_description}
              onChange={(value) => setForm((prev) => ({ ...prev, meta_description: value }))}
              autoComplete="off"
              multiline={2}
              placeholder={seoPlainPreview(form.description, 160)}
            />
            <TextField
              label="Keywords"
              value={form.keywords}
              onChange={(value) => setForm((prev) => ({ ...prev, keywords: value }))}
              autoComplete="off"
              placeholder="comma-separated"
            />
            <Box>
              <Text as="span" variant="bodyMd" fontWeight="medium">Main image (menus / dropdown)</Text>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
                {form.image_url ? (
                  <div style={{ width: 100, aspectRatio: 1, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-fill-secondary)", position: "relative" }}>
                    <img
                      src={form.image_url.startsWith("http") || form.image_url.startsWith("data:") ? form.image_url : `${baseUrl}${form.image_url}`}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, image_url: "" }))}
                      style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", fontSize: 14 }}
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                ) : null}
                <div
                  onClick={() => setMainImgPickerOpen(true)}
                  style={{ width: 100, aspectRatio: 1, borderRadius: 8, border: "2px dashed var(--p-color-border)", background: "var(--p-color-bg-fill-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <span style={{ fontSize: 24, color: "var(--p-color-icon)" }}>+</span>
                </div>
              </div>
            </Box>
            <Box>
              <Text as="span" variant="bodyMd" fontWeight="medium">Category banner (shop category page)</Text>
              <div style={{ marginTop: 8 }}>
                {form.banner_image_url ? (
                  <div style={{ maxWidth: 320, height: 50, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-fill-secondary)", position: "relative" }}>
                    <img
                      src={form.banner_image_url.startsWith("http") || form.banner_image_url.startsWith("data:") ? form.banner_image_url : `${baseUrl}${form.banner_image_url}`}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, banner_image_url: "" }))}
                      style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", fontSize: 14 }}
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                ) : null}
                {!form.banner_image_url && (
                  <div
                    onClick={() => setBannerImgPickerOpen(true)}
                    style={{ width: 200, height: 50, borderRadius: 8, border: "2px dashed var(--p-color-border)", background: "var(--p-color-bg-fill-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                  >
                    <span style={{ fontSize: 18, color: "var(--p-color-icon)" }}>+ Banner</span>
                  </div>
                )}
              </div>
            </Box>
            <RichTextEditor
              label="Richtext (below products on category page)"
              value={form.richtext || ""}
              onChange={(value) => setForm((prev) => ({ ...prev, richtext: value }))}
              minHeight="180px"
              helpText="Supports visual editing and HTML mode."
            />
            <MediaPickerModal
              open={mainImgPickerOpen}
              onClose={() => setMainImgPickerOpen(false)}
              title="Ana görsel seç"
              multiple={false}
              onUploadingChange={setBannerUploading}
              onSelect={(urls) => { if (urls[0]) setForm((prev) => ({ ...prev, image_url: urls[0] })); }}
            />
            <MediaPickerModal
              open={bannerImgPickerOpen}
              onClose={() => setBannerImgPickerOpen(false)}
              title="Banner görseli seç"
              multiple={false}
              onUploadingChange={setBannerUploading}
              onSelect={(urls) => { if (urls[0]) setForm((prev) => ({ ...prev, banner_image_url: urls[0] })); }}
            />
            <Checkbox
              label="Has collection (create or link collection page)"
              checked={form.has_collection}
              onChange={(value) => setForm((prev) => ({ ...prev, has_collection: value }))}
            />
            {form.has_collection && (
              <Select
                label="Link to existing collection (optional)"
                options={[
                  { label: "— Auto-create new collection —", value: "" },
                  ...medusaCollections.map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
                ]}
                value={form.collection_id}
                onChange={(value) => setForm((prev) => ({ ...prev, collection_id: value }))}
                helpText="Leave as 'Auto-create' for 'Parent > Child' or category name collection."
              />
            )}
            <Checkbox
              label="Active"
              checked={form.active}
              onChange={(value) => setForm((prev) => ({ ...prev, active: value }))}
            />
            <Checkbox
              label="Visible in store"
              checked={form.is_visible}
              onChange={(value) => setForm((prev) => ({ ...prev, is_visible: value }))}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
