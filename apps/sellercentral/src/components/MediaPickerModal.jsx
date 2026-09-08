"use client";

/**
 * MediaPickerModal — shared media picker used everywhere in sellercentral.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Text,
  Button,
  TextField,
  Box,
  Divider,
  DropZone,
} from "@shopify/polaris";
import { useLt } from "@/lib/use-locale-text";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { appendMediaFileToFormData } from "@/lib/media-upload";

const BACKEND_URL = (
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || ""
    : ""
).replace(/\/$/, "");

function resolveUrl(url) {
  if (!url || typeof url !== "string") return "";
  const u = url.trim();
  if (u.startsWith("http") || u.startsWith("data:")) return u;
  return `${BACKEND_URL}${u.startsWith("/") ? "" : "/"}${u}`;
}

function isVideoUrl(url) {
  return /\.(mp4|webm|mov|avi|ogv)(\?.*)?$/i.test(String(url || ""));
}

async function readImageBitmap(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = objectUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function inspectProductImageFile(file) {
  const img = await readImageBitmap(file);
  const width = Number(img.naturalWidth || img.width || 0);
  const height = Number(img.naturalHeight || img.height || 0);
  const minSizeOk = width >= 1000 && height >= 1000;
  const squareOk = width === height;

  let whiteCornersOk = false;
  try {
    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.min(64, width));
    const h = Math.max(1, Math.min(64, height));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, w, h);
      const points = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ];
      const threshold = 246;
      whiteCornersOk = points.every(([x, y]) => {
        const p = ctx.getImageData(x, y, 1, 1).data;
        return p[3] >= 245 && p[0] >= threshold && p[1] >= threshold && p[2] >= threshold;
      });
    }
  } catch {
    whiteCornersOk = false;
  }

  return { width, height, minSizeOk, squareOk, whiteCornersOk };
}

export default function MediaPickerModal({
  open,
  onClose,
  onSelect,
  multiple = false,
  title,
  onUploadingChange,
  uploadPurpose,
}) {
  const lt = useLt();
  const client = getMedusaAdminClient();

  const resolvedTitle = title ?? lt("Select media", "Medya seç", "Sélectionner un média", "Seleccionar medio", "Seleziona media", "Medien auswählen");

  const [library, setLibrary] = useState([]);
  const [loadingLib, setLoadingLib] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadWarnings, setUploadWarnings] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [urlInput, setUrlInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setUrlInput("");
    setUploadError("");
    setUploadWarnings([]);
    setLoadingLib(true);
    client
      .getMedia({ limit: 1000 })
      .then((r) => setLibrary(r.media || []))
      .catch(() => setLibrary([]))
      .finally(() => setLoadingLib(false));
  }, [open, client]);

  const toggle = (url) => {
    const resolved = resolveUrl(url);
    if (multiple) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(resolved) ? next.delete(resolved) : next.add(resolved);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set();
        if (!prev.has(resolved)) next.add(resolved);
        return next;
      });
    }
  };

  const handleUpload = useCallback(
    (files) => {
      const list = Array.isArray(files) ? files : [files];
      if (!list.length) return;
      setUploadError("");
      setUploadWarnings([]);
      setUploading(true);
      onUploadingChange?.(true);
      const uploadOpts = uploadPurpose === "product" ? { purpose: "product" } : {};
      Promise.all(
        list.map(async (file) => {
          if (uploadPurpose === "product") {
            const analysis = await inspectProductImageFile(file).catch(() => null);
            if (analysis) {
              const warns = [];
              if (!analysis.squareOk) warns.push(lt("not square", "kare değil", "pas carré", "no cuadrado", "non quadrato", "nicht quadratisch"));
              if (!analysis.minSizeOk) warns.push(lt("below 1000×1000", "1000×1000 altında", "moins de 1000×1000", "menos de 1000×1000", "sotto 1000×1000", "unter 1000×1000"));
              if (!analysis.whiteCornersOk) warns.push(lt("background may not be pure white (#ffffff)", "arka plan saf beyaz olmayabilir (#ffffff)", "fond peut ne pas être blanc pur (#ffffff)", "fondo puede no ser blanco puro (#ffffff)", "sfondo potrebbe non essere bianco puro (#ffffff)", "Hintergrund evtl. nicht reinweiß (#ffffff)"));
              if (warns.length) {
                setUploadWarnings((prev) => [
                  ...prev,
                  `${file.name}: ${warns.join(", ")}.`,
                ]);
              }
            }
          }
          const fd = new FormData();
          appendMediaFileToFormData(fd, file);
          return client.uploadMedia(fd, uploadOpts).then((r) => r.url || null);
        }),
      )
        .then((urls) => {
          const valid = urls.filter(Boolean);
          const newItems = valid.map((u, i) => ({
            id: `up-${Date.now()}-${i}`,
            url: u,
            filename: u.split("/").pop(),
          }));
          setLibrary((prev) => [...newItems, ...prev]);
          if (valid.length) {
            const resolved = resolveUrl(valid[0]);
            setSelected((prev) => {
              if (multiple) {
                const next = new Set(prev);
                valid.forEach((u) => next.add(resolveUrl(u)));
                return next;
              }
              return new Set([resolved]);
            });
          }
        })
        .catch((e) => {
          setUploadError(e?.message || lt("Upload failed", "Yükleme başarısız", "Échec du téléchargement", "Error al subir", "Caricamento non riuscito", "Upload fehlgeschlagen"));
        })
        .finally(() => {
          setUploading(false);
          onUploadingChange?.(false);
        });
    },
    [client, multiple, uploadPurpose, lt, onUploadingChange],
  );

  const handleApply = () => {
    const urlLines = urlInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("http"));

    const all = [...Array.from(selected), ...urlLines.filter((u) => !selected.has(u))];
    if (!all.length) return;
    onSelect(all);
    onClose();
  };

  const canApply = selected.size > 0 || urlInput.trim().startsWith("http");

  // Only mount the Polaris Modal while open. A permanently-mounted Modal keeps an
  // earlier portal node; when opened from inside another Modal (e.g. Badge
  // bearbeiten) that portal stays behind the first Modal at the same z-index.
  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={resolvedTitle}
      size="large"
    >
      <Modal.Section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <TextField
              label={multiple
                ? lt("Add via URL (one per line)", "URL ile ekle (her satıra bir)", "Ajouter via URL (une par ligne)", "Añadir por URL (una por línea)", "Aggiungi via URL (una per riga)", "Per URL hinzufügen (eine pro Zeile)")
                : lt("Add via URL", "URL ile ekle", "Ajouter via URL", "Añadir por URL", "Aggiungi via URL", "Per URL hinzufügen")}
              value={urlInput}
              onChange={setUrlInput}
              placeholder="https://..."
              multiline={multiple ? 3 : 1}
              autoComplete="off"
              helpText={multiple
                ? lt("One URL per line, or comma-separated", "Her satıra bir URL veya virgülle ayrılmış", "Une URL par ligne ou séparées par des virgules", "Una URL por línea o separadas por comas", "Un URL per riga o separati da virgola", "Eine URL pro Zeile oder kommagetrennt")
                : undefined}
            />
          </div>
          <div style={{ alignSelf: "end", display: "flex", gap: 8, paddingBottom: 2 }}>
            <Button variant="primary" onClick={handleApply} disabled={!canApply || uploading}>
              {lt("Save", "Kaydet", "Enregistrer", "Guardar", "Salva", "Speichern")}
            </Button>
            <Button onClick={onClose} disabled={uploading}>
              {lt("Discard", "İptal", "Annuler", "Descartar", "Annulla", "Verwerfen")}
            </Button>
          </div>
        </div>

        <Divider />
        {uploadPurpose === "product" && (
          <Box paddingBlockEnd="200">
            <Text as="p" variant="bodySm" tone="subdued">
              {lt(
                "Product images: JPEG or PNG, at least 1000×1000 px; upload is saved as square WebP (1000×1000).",
                "Ürün görselleri: JPEG veya PNG, en az 1000×1000 px; yükleme kare WebP (1000×1000) olarak kaydedilir.",
                "Images produit : JPEG ou PNG, min. 1000×1000 px ; enregistrées en WebP carré (1000×1000).",
                "Imágenes de producto: JPEG o PNG, mín. 1000×1000 px; se guardan como WebP cuadrado (1000×1000).",
                "Immagini prodotto: JPEG o PNG, min. 1000×1000 px; salvate come WebP quadrato (1000×1000).",
                "Produktbilder: JPEG oder PNG, mindestens 1000×1000 px; Upload wird als quadratisches WebP (1000×1000) gespeichert.",
              )}
            </Text>
          </Box>
        )}
        <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">
          {lt("Select from media library", "Medya kütüphanesinden seç", "Choisir dans la bibliothèque", "Seleccionar de la biblioteca", "Seleziona dalla libreria", "Aus Medienbibliothek wählen")}
        </Text>
      </Modal.Section>

      <Modal.Section>
        {uploadError && (
          <Box paddingBlockEnd="300">
            <Text as="p" variant="bodySm" tone="critical">{uploadError}</Text>
          </Box>
        )}
        {uploadWarnings.length > 0 && (
          <Box paddingBlockEnd="300">
            <Text as="p" variant="bodySm" tone="critical">
              {lt("Image criteria warning:", "Görsel kriter uyarısı:", "Avertissement critères image :", "Advertencia de criterios de imagen:", "Avviso criteri immagine:", "Hinweis Bildkriterien:")}
            </Text>
            <div style={{ marginTop: 6 }}>
              {uploadWarnings.map((w, i) => (
                <Text key={`${w}-${i}`} as="p" variant="bodySm" tone="subdued">
                  - {w}
                </Text>
              ))}
            </div>
            <Text as="p" variant="bodySm" tone="subdued">
              {lt(
                "Main image should be square, at least 1000×1000, and white background (#ffffff).",
                "Ana görsel kare, en az 1000×1000 ve beyaz arka plan (#ffffff) olmalı.",
                "L'image principale doit être carrée, min. 1000×1000, fond blanc (#ffffff).",
                "La imagen principal debe ser cuadrada, mín. 1000×1000 y fondo blanco (#ffffff).",
                "L'immagine principale deve essere quadrata, min. 1000×1000 e sfondo bianco (#ffffff).",
                "Hauptbild sollte quadratisch, mindestens 1000×1000 und weißer Hintergrund (#ffffff) sein.",
              )}
            </Text>
          </Box>
        )}
        {uploading && (
          <Box paddingBlockEnd="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {lt("Uploading…", "Yükleniyor…", "Téléchargement…", "Subiendo…", "Caricamento…", "Wird hochgeladen…")}
            </Text>
          </Box>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 10,
          }}
        >
          <DropZone
            accept={uploadPurpose === "product" ? "image/jpeg,image/png" : "image/*,video/mp4,video/webm,video/quicktime,video/ogg"}
            type={uploadPurpose === "product" ? "image" : "file"}
            onDropAccepted={handleUpload}
            allowMultiple={multiple}
          >
            <div
              style={{
                aspectRatio: "1",
                border: "2px dashed var(--p-color-border)",
                borderRadius: 8,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                cursor: "pointer",
                background: "var(--p-color-bg-fill-secondary)",
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 16 16" fill="var(--p-color-icon-subdued)">
                <path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5z" />
              </svg>
              <span style={{ fontSize: 10, color: "var(--p-color-text-subdued)" }}>
                {lt("Upload", "Yükle", "Téléverser", "Subir", "Carica", "Hochladen")}
              </span>
            </div>
          </DropZone>

          {loadingLib
            ? Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  style={{ aspectRatio: "1", borderRadius: 8, background: "var(--p-color-bg-fill-secondary)" }}
                />
              ))
            : library.map((item) => {
                const url = item.url ? resolveUrl(item.url) : "";
                if (!url) return null;
                const isSelected = selected.has(url);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggle(item.url)}
                    style={{
                      position: "relative",
                      aspectRatio: "1",
                      padding: 0,
                      border: isSelected
                        ? "2.5px solid var(--p-color-border-focus)"
                        : "2px solid transparent",
                      borderRadius: 8,
                      overflow: "hidden",
                      cursor: "pointer",
                      background: "var(--p-color-bg-fill-secondary)",
                      outline: "none",
                    }}
                  >
                    {isVideoUrl(url) ? (
                      <video
                        src={url}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        preload="metadata"
                        muted
                        playsInline
                      />
                    ) : (
                      <img
                        src={url}
                        alt={item.alt || item.filename || ""}
                        referrerPolicy="no-referrer"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    )}
                    {isSelected && (
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: "var(--p-color-border-focus)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0Z" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
        </div>
        {library.length === 0 && !loadingLib && (
          <Box paddingBlockStart="300">
            <Text as="p" tone="subdued">
              {lt(
                "No media yet. Drag an image onto the + box above or click it.",
                "Henüz medya yok. Görseli yukarıdaki + kutusuna sürükleyin veya tıklayın.",
                "Aucun média. Glissez une image sur la case + ou cliquez.",
                "Sin medios. Arrastre una imagen al cuadro + o haga clic.",
                "Nessun media. Trascina un'immagine sul riquadro + o clicca.",
                "Noch keine Medien. Bild auf das + Feld ziehen oder klicken.",
              )}
            </Text>
          </Box>
        )}
      </Modal.Section>
    </Modal>
  );
}
