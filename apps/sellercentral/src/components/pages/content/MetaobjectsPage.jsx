"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Page, Card, Text, Button, TextField, Badge, Select,
  BlockStack, InlineStack, Box, Spinner, Banner, Modal, Tag,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { useLocale } from "next-intl";
import { getMetaobjectsCopy, METAOBJECT_LANGS, slugifyMetaKey, resolveSafeMetaobjectKey, localizedMetaobjectLabel, localizedMetaobjectValue } from "@/lib/metaobjects-i18n";
import { getLandingEditorCopy } from "@/lib/landing-page-editor-i18n";
import { getUI } from "@/lib/ui-strings";
import { confirmDelete } from "@/lib/confirm-delete";

const client = getMedusaAdminClient();

function emptyLangDraft() {
  const d = {};
  METAOBJECT_LANGS.forEach((L) => { d[L.code] = ""; });
  return d;
}

function titleDraftFromDef(def) {
  const d = emptyLangDraft();
  d.de = def?.label || "";
  const i18n = def?.label_i18n && typeof def.label_i18n === "object" ? def.label_i18n : {};
  METAOBJECT_LANGS.forEach((L) => {
    if (L.code === "de") return;
    d[L.code] = i18n[L.code]?.label || "";
  });
  return d;
}

function valueDraftFromDef(def, canonical) {
  const d = emptyLangDraft();
  d.de = canonical || "";
  const i18n = def?.values_i18n && typeof def.values_i18n === "object" ? def.values_i18n : {};
  METAOBJECT_LANGS.forEach((L) => {
    if (L.code === "de") return;
    d[L.code] = i18n[L.code]?.[canonical] || "";
  });
  return d;
}

function DropZone({ onFile, accept, label, hint }) {
  const [drag, setDrag] = useState(false);
  const [fileName, setFileName] = useState(null);
  const inputRef = useRef();

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) { setFileName(f.name); onFile(f); }
  }, [onFile]);

  const handleFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (f) { setFileName(f.name); onFile(f); }
  }, [onFile]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${drag ? "#2563eb" : "#d1d5db"}`,
        borderRadius: 10,
        padding: "24px 20px",
        background: drag ? "#eff6ff" : "#fafafa",
        cursor: "pointer",
        textAlign: "center",
      }}
    >
      <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }} onChange={handleFile} />
      <Text as="p" variant="bodyMd" fontWeight="semibold">
        {fileName ? `✓ ${fileName}` : label}
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>
    </div>
  );
}

export default function MetaobjectsPage() {
  const locale = useLocale();
  const ui = getUI(locale);
  const c = getMetaobjectsCopy(locale);
  const langOptions = getLandingEditorCopy(locale).shopContentLangOptions();
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [definitions, setDefinitions] = useState({});
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [pendingActionId, setPendingActionId] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [search, setSearch] = useState("");
  const [pendingOpen, setPendingOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  const [viewLang, setViewLang] = useState(() => String(locale || "de").slice(0, 2));
  const [titleModal, setTitleModal] = useState(null);
  const [titleLang, setTitleLang] = useState("de");
  const [titleDraft, setTitleDraft] = useState(emptyLangDraft());
  const [titleKey, setTitleKey] = useState("");
  const [titleKeyErr, setTitleKeyErr] = useState("");

  const [valueModal, setValueModal] = useState(null);
  const [valueLang, setValueLang] = useState("de");
  const [valueDraft, setValueDraft] = useState(emptyLangDraft());

  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await client.getMetafieldDefinitions();
      const defs = res?.definitions || {};
      setDefinitions(defs);
      setSelectedKey((prev) => (prev && defs[prev] ? prev : Object.keys(defs).sort()[0] || ""));
      const sup = typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true";
      if (sup) {
        try {
          const pr = await client.getMetafieldPendingProposals();
          setPending(Array.isArray(pr?.pending) ? pr.pending : []);
        } catch {
          setPending([]);
        }
      } else {
        setPending([]);
      }
    } catch (e) {
      setError(e?.message || c.loadError);
    } finally {
      setLoading(false);
    }
  }, [c.loadError]);

  useEffect(() => { load(); }, [load]);

  const persistDef = async (key, next) => {
    setSaving(key);
    try {
      await client.putMetafieldDefinition(key, next);
    } catch (e) {
      setError(e?.message || c.saveError);
    } finally {
      setSaving("");
    }
  };

  const saveDef = async (key, patch) => {
    const prev = definitionsRef.current[key] || { label: key, values: [], label_i18n: null, values_i18n: null };
    const next = {
      label: patch.label !== undefined ? patch.label : prev.label,
      values: patch.values !== undefined ? patch.values : (prev.values || []),
      label_i18n: patch.label_i18n !== undefined ? patch.label_i18n : (prev.label_i18n || null),
      values_i18n: patch.values_i18n !== undefined ? patch.values_i18n : (prev.values_i18n || null),
    };
    setDefinitions((p) => {
      const merged = { ...p, [key]: next };
      definitionsRef.current = merged;
      return merged;
    });
    await persistDef(key, next);
  };

  const sortedKeys = useMemo(() => Object.keys(definitions).sort((a, b) => {
    const la = (localizedMetaobjectLabel(definitions[a], viewLang) || a).toLocaleLowerCase();
    const lb = (localizedMetaobjectLabel(definitions[b], viewLang) || b).toLocaleLowerCase();
    return la.localeCompare(lb);
  }), [definitions, viewLang]);

  const filteredKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedKeys;
    return sortedKeys.filter((key) => {
      const def = definitions[key];
      const hay = [
        key,
        def?.label,
        ...METAOBJECT_LANGS.map((L) => def?.label_i18n?.[L.code]?.label),
        ...(def?.values || []),
        ...METAOBJECT_LANGS.flatMap((L) => Object.values(def?.values_i18n?.[L.code] || {})),
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [sortedKeys, search, definitions]);

  const selected = selectedKey ? definitions[selectedKey] : null;

  const openNewTitle = () => {
    setTitleModal({ isNew: true });
    setTitleLang(viewLang);
    setTitleDraft(emptyLangDraft());
    setTitleKey("");
    setTitleKeyErr("");
  };

  const openEditTitle = (key) => {
    const def = definitions[key];
    if (!def) return;
    setTitleModal({ isNew: false, key });
    setTitleLang(viewLang);
    setTitleDraft(titleDraftFromDef(def));
    setTitleKey(key);
    setTitleKeyErr("");
  };

  const saveTitleModal = async () => {
    const deLabel = (titleDraft.de || Object.values(titleDraft).find(Boolean) || "").trim();
    if (!deLabel) return;
    let key = titleModal?.isNew
      ? (resolveSafeMetaobjectKey(titleKey || deLabel) || resolveSafeMetaobjectKey(deLabel))
      : titleModal.key;
    if (!key) { setTitleKeyErr(c.keyRequired); return; }
    if (titleModal?.isNew && definitions[key]) { setTitleKeyErr(c.keyExists); return; }
    const label_i18n = {};
    METAOBJECT_LANGS.forEach((L) => {
      if (L.code === "de") return;
      const t = (titleDraft[L.code] || "").trim();
      if (t) label_i18n[L.code] = { label: t };
    });
    const prev = definitions[key];
    await saveDef(key, {
      label: (titleDraft.de || deLabel).trim() || deLabel,
      values: prev?.values || [],
      label_i18n: Object.keys(label_i18n).length ? label_i18n : null,
      values_i18n: prev?.values_i18n || null,
    });
    setSelectedKey(key);
    setTitleModal(null);
  };

  const openNewValue = (key) => {
    setValueModal({ isNew: true, defKey: key, canonical: "" });
    setValueLang(viewLang);
    setValueDraft(emptyLangDraft());
  };

  const openEditValue = (key, canonical) => {
    setValueModal({ isNew: false, defKey: key, canonical });
    setValueLang(viewLang);
    setValueDraft(valueDraftFromDef(definitions[key], canonical));
  };

  const saveValueModal = async () => {
    const defKey = valueModal?.defKey;
    const def = definitions[defKey];
    if (!def) return;
    const canonicalNew = (valueDraft.de || Object.values(valueDraft).find(Boolean) || "").trim();
    if (!canonicalNew) return;
    const old = valueModal.canonical;
    let values = [...(def.values || [])];
    let values_i18n = def.values_i18n && typeof def.values_i18n === "object" ? JSON.parse(JSON.stringify(def.values_i18n)) : {};
    if (valueModal.isNew) {
      if (!values.some((v) => String(v).toLowerCase() === canonicalNew.toLowerCase())) values = [...values, canonicalNew].sort();
    } else if (old && old !== canonicalNew) {
      values = values.map((v) => (v === old ? canonicalNew : v));
      for (const loc of Object.keys(values_i18n)) {
        const map = values_i18n[loc];
        if (!map || typeof map !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(map, old)) {
          map[canonicalNew] = map[old];
          delete map[old];
        }
      }
    }
    METAOBJECT_LANGS.forEach((L) => {
      if (L.code === "de") return;
      const t = (valueDraft[L.code] || "").trim();
      if (!values_i18n[L.code]) values_i18n[L.code] = {};
      if (t) values_i18n[L.code][canonicalNew] = t;
      else delete values_i18n[L.code][canonicalNew];
      if (!Object.keys(values_i18n[L.code]).length) delete values_i18n[L.code];
    });
    await saveDef(defKey, { values, values_i18n: Object.keys(values_i18n).length ? values_i18n : null });
    setValueModal(null);
  };

  const removeValue = async (key, val) => {
    const def = definitions[key];
    if (!def) return;
    const values = (def.values || []).filter((v) => v !== val);
    let values_i18n = def.values_i18n || null;
    if (values_i18n && typeof values_i18n === "object") {
      const cleaned = {};
      for (const [lang, map] of Object.entries(values_i18n)) {
        if (!map || typeof map !== "object") continue;
        const nextMap = { ...map };
        delete nextMap[val];
        if (Object.keys(nextMap).length) cleaned[lang] = nextMap;
      }
      values_i18n = Object.keys(cleaned).length ? cleaned : null;
    }
    await saveDef(key, { values, values_i18n });
  };

  const deleteDef = async (key) => {
    if (!isSuperuser) return;
    if (!(await confirmDelete(`${definitions[key]?.label || key}`))) return;
    setSaving(key);
    try {
      await client.deleteMetafieldDefinition(key);
      setDefinitions((prev) => {
        const n = { ...prev };
        delete n[key];
        definitionsRef.current = n;
        return n;
      });
      setSelectedKey((prev) => (prev === key ? "" : prev));
    } catch (e) {
      setError(e?.message || ui.error);
    } finally {
      setSaving("");
    }
  };

  const approvePending = async (id) => {
    setPendingActionId(id);
    try {
      await client.approveMetafieldProposal(id);
      await load();
    } catch (e) {
      setError(e?.message || c.approvalFailed);
    } finally {
      setPendingActionId("");
    }
  };
  const editAndApprovePending = async (p) => {
    const current = Array.isArray(p?.proposed_values) ? p.proposed_values.join(", ") : "";
    const raw = window.prompt(c.editPrompt, current);
    if (raw == null) return;
    const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    setPendingActionId(p.id);
    try {
      await client.approveMetafieldProposal(p.id, { values, label: (p.label || p.key || "").trim() });
      await load();
    } catch (e) {
      setError(e?.message || c.editApprovalFailed);
    } finally {
      setPendingActionId("");
    }
  };
  const rejectPending = async (id) => {
    setPendingActionId(id);
    try {
      await client.rejectMetafieldProposal(id);
      await load();
    } catch (e) {
      setError(e?.message || c.rejectionFailed);
    } finally {
      setPendingActionId("");
    }
  };

  const downloadTemplate = async () => {
    const res = await fetch("/api/metaobjects/template");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "andertal-metaobjects-template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async () => {
    if (!importFile) { setImportMsg({ tone: "warning", text: c.chooseFile }); return; }
    setImporting(true);
    setImportMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      fd.append("sellerToken", typeof window !== "undefined" ? (localStorage.getItem("sellerToken") || "") : "");
      const res = await fetch("/api/metaobjects/import", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || c.importFail);
      let text = c.importOk(data.created || 0, data.updated || 0, data.valuesAdded || 0);
      if (Array.isArray(data.remapped) && data.remapped.length) {
        text += ` ${data.remapped.map((r) => `${r.from}→${r.to}`).join(", ")}`;
      }
      if (Array.isArray(data.errors) && data.errors.length) {
        text += ` — ${data.errors.map((e) => e.key + ": " + e.error).join("; ")}`;
      }
      setImportMsg({
        tone: data.ok === false || (data.errors && data.errors.length) ? "warning" : "success",
        text,
      });
      await load();
    } catch (e) {
      setImportMsg({ tone: "critical", text: e?.message || c.importFail });
    } finally {
      setImporting(false);
    }
  };

  const isSaving = saving === selectedKey;

  return (
    <Page
      title={c.pageTitle}
      subtitle={c.pageSubtitle}
      primaryAction={
        isSuperuser
          ? { content: c.newDefinition, onAction: openNewTitle }
          : undefined
      }
      secondaryActions={
        isSuperuser
          ? [
              ...(pending.length
                ? [{ content: c.pendingBadge(pending.length), onAction: () => setPendingOpen(true), destructive: true }]
                : []),
              { content: c.importBtn, onAction: () => { setImportFile(null); setImportMsg(null); setImportOpen(true); } },
            ]
          : undefined
      }
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}

        <Card>
          <Select
            label={c.langPicker}
            options={langOptions}
            value={viewLang}
            onChange={setViewLang}
            helpText={c.langHelp}
          />
        </Card>

        {loading ? (
          <Card><Box padding="600"><InlineStack align="center"><Spinner /></InlineStack></Box></Card>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)",
              gap: 12,
              alignItems: "stretch",
              minHeight: 420,
            }}
          >
            <Card padding="0">
              <Box padding="300">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">{c.titles}</Text>
                  <TextField
                    label={c.searchTitles}
                    labelHidden
                    value={search}
                    onChange={setSearch}
                    placeholder={c.searchTitles}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearch("")}
                  />
                </BlockStack>
              </Box>
              <div style={{ borderTop: "1px solid #e5e7eb", maxHeight: 560, overflowY: "auto" }}>
                {filteredKeys.length === 0 ? (
                  <Box padding="400"><Text as="p" tone="subdued" variant="bodySm">{sortedKeys.length ? c.noMatch : c.emptyHeading}</Text></Box>
                ) : filteredKeys.map((key) => {
                  const def = definitions[key];
                  const active = key === selectedKey;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px 12px",
                        border: "none",
                        borderLeft: active ? "3px solid #111827" : "3px solid transparent",
                        background: active ? "#f3f4f6" : "#fff",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: active ? 600 : 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {localizedMetaobjectLabel(def, viewLang) || key}
                      </span>
                      <Badge>{(def?.values || []).length}</Badge>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card>
              {!selected ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">{sortedKeys.length === 0 ? (isSuperuser ? c.emptySuperuser : c.emptySeller) : c.selectTitle}</Text>
                </Box>
              ) : (
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingSm">{localizedMetaobjectLabel(selected, viewLang) || selectedKey}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        key: <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{selectedKey}</code>
                      </Text>
                    </BlockStack>
                    {isSuperuser ? (
                      <InlineStack gap="200">
                        <Button size="slim" onClick={() => openEditTitle(selectedKey)}>{ui.edit}</Button>
                        <Button size="slim" onClick={() => openNewValue(selectedKey)} disabled={isSaving}>+ {c.addValue}</Button>
                        <Button size="slim" tone="critical" variant="plain" onClick={() => deleteDef(selectedKey)} loading={isSaving}>
                          {ui.delete}
                        </Button>
                      </InlineStack>
                    ) : null}
                  </InlineStack>

                  {(selected.values || []).length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {c.noValues}{isSuperuser ? <> {c.clickAddValue}</> : null}
                    </Text>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {(selected.values || []).map((val) => (
                        <div
                          key={val}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            padding: "6px 10px",
                            border: "1px solid #e5e7eb",
                            borderRadius: 8,
                            background: "#fff",
                          }}
                        >
                          <Text as="span" variant="bodySm">{localizedMetaobjectValue(selected, val, viewLang)}</Text>
                          {isSuperuser ? (
                            <InlineStack gap="100">
                              <Button size="slim" onClick={() => openEditValue(selectedKey, val)}>{ui.edit}</Button>
                              <Button size="slim" tone="critical" variant="plain" onClick={() => removeValue(selectedKey, val)}>{ui.delete}</Button>
                            </InlineStack>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </BlockStack>
              )}
            </Card>
          </div>
        )}
      </BlockStack>

      <Modal
        open={!!titleModal}
        onClose={() => setTitleModal(null)}
        title={titleModal?.isNew ? c.modalNewTitle : c.editTitle}
        primaryAction={{ content: titleModal?.isNew ? c.create : ui.save, onAction: saveTitleModal }}
        secondaryActions={[{ content: c.cancel, onAction: () => setTitleModal(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Select label={c.langPicker} options={langOptions} value={titleLang} onChange={setTitleLang} helpText={c.langHelp} />
            {titleModal?.isNew ? (
              <TextField
                label={c.fieldKey}
                value={titleKey}
                onChange={(v) => { setTitleKey(v); setTitleKeyErr(""); }}
                helpText={c.fieldKeyHelp}
                error={titleKeyErr}
                autoComplete="off"
                placeholder={slugifyMetaKey(titleDraft.de || titleDraft[titleLang] || "")}
              />
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">key: {titleModal?.key}</Text>
            )}
            <TextField
              label={c.fieldLabel}
              value={titleDraft[titleLang] || ""}
              onChange={(v) => setTitleDraft((d) => ({ ...d, [titleLang]: v }))}
              helpText={titleLang === "de" ? c.catalogLangHint : c.fieldLabelHelp}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={!!valueModal}
        onClose={() => setValueModal(null)}
        title={valueModal?.isNew ? c.modalAddValueTitle : c.editValue}
        primaryAction={{ content: valueModal?.isNew ? c.add : ui.save, onAction: saveValueModal }}
        secondaryActions={[{ content: c.cancel, onAction: () => setValueModal(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Select label={c.langPicker} options={langOptions} value={valueLang} onChange={setValueLang} helpText={c.langHelp} />
            <TextField
              label={c.addValue}
              value={valueDraft[valueLang] || ""}
              onChange={(v) => setValueDraft((d) => ({ ...d, [valueLang]: v }))}
              placeholder={c.valuePh}
              autoComplete="off"
              helpText={valueLang === "de" ? c.catalogLangHint : undefined}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={pendingOpen}
        onClose={() => setPendingOpen(false)}
        title={c.pendingModalTitle}
        secondaryActions={[{ content: ui.close, onAction: () => setPendingOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">{c.pendingHelp}</Text>
            {pending.map((p) => (
              <Box key={p.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{p.label || p.key}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    key: {p.key}
                    {p.seller_id ? <> · {c.seller}: {p.seller_id}</> : null}
                  </Text>
                  <InlineStack gap="150" wrap>
                    {(p.proposed_values || []).map((v) => <Tag key={v}>{v}</Tag>)}
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button size="slim" variant="primary" loading={pendingActionId === p.id} onClick={() => approvePending(p.id)}>{c.approve}</Button>
                    <Button size="slim" onClick={() => editAndApprovePending(p)} disabled={pendingActionId === p.id}>{c.editApprove}</Button>
                    <Button size="slim" tone="critical" onClick={() => rejectPending(p.id)} disabled={pendingActionId === p.id}>{c.reject}</Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={c.importTitle}
        primaryAction={{ content: importing ? c.importing : c.importAction, onAction: runImport, loading: importing }}
        secondaryActions={[{ content: c.cancel, onAction: () => setImportOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {importMsg && <Banner tone={importMsg.tone} onDismiss={() => setImportMsg(null)}>{importMsg.text}</Banner>}
            <Text as="p" variant="bodySm">{c.importHelp}</Text>
            <Button onClick={downloadTemplate}>{c.downloadTemplate}</Button>
            <DropZone
              onFile={setImportFile}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              label={c.dropLabel}
              hint={c.dropHint}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
