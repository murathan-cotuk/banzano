import { lt } from "@/lib/locale-text";

export const METAOBJECT_LANGS = [
  { code: "en", name: "English" },
  { code: "de", name: "German" },
  { code: "tr", name: "Turkish" },
  { code: "fr", name: "French" },
  { code: "it", name: "Italian" },
  { code: "es", name: "Spanish" },
];

export function localizedMetaobjectLabel(def, lang) {
  const loc = String(lang || "de").slice(0, 2).toLowerCase();
  if (loc && loc !== "de") {
    const t = def?.label_i18n?.[loc]?.label;
    if (t != null && String(t).trim()) return String(t).trim();
  }
  return String(def?.label || "").trim();
}

export function localizedMetaobjectValue(def, canonical, lang) {
  const loc = String(lang || "de").slice(0, 2).toLowerCase();
  const raw = canonical == null ? "" : String(canonical);
  if (loc && loc !== "de") {
    const map = def?.values_i18n?.[loc];
    const t = map && typeof map === "object" ? (map[raw] ?? map[raw.trim()]) : null;
    if (t != null && String(t).trim()) return String(t).trim();
  }
  return raw;
}

export function slugifyMetaKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

/** Product-metadata reserved keys — must not be used as catalog metaobject keys. */
export const SYSTEM_METAOBJECT_KEYS = new Set([
  "media", "image_url", "image", "thumbnail", "ean", "sku", "handle", "title", "description", "status",
  "inventory", "price", "type", "bullet_points", "bullet1", "bullet2", "bullet3", "bullet4", "bullet5",
  "translations", "variation_groups", "metafields", "shipping_group_id", "collection_id", "collection_ids",
  "admin_category_id", "category_id", "category_ids", "category_slug", "category",
  "seller_id", "product_id", "brand_id", "brand_logo", "brand_handle",
  "brand", "brand_name", "shop_name", "store_name", "seller_name", "hersteller", "hersteller_information",
  "verantwortliche_person_information", "manufacturer", "manufacturer_information",
  "responsible_person_information", "seo_keywords", "seo_meta_title", "seo_meta_description",
  "publish_date", "return_days", "return_cost", "return_kostenlos", "related_product_ids",
  "dimensions", "dimensions_length", "dimensions_width", "dimensions_height", "weight", "weight_grams",
  "unit_type", "unit_value", "unit_reference", "sales_unit", "packaging_unit", "packaging_unit_plural",
  "minimum_order_quantity", "shipping_info", "versand", "rabattpreis_cents",
  "uvp_cents", "price_cents", "compare_at_price_cents", "sale_price_cents", "review_count",
  "review_avg", "sold_last_month", "sold", "sales_count", "salescount", "sold_count",
  "master_total_variants", "master_total_variant", "total_variants", "variant_count", "variants_count",
  "is_new", "badge", "sale", "is_bestseller", "view_count", "views", "prices", "custom_badges",
  "eu_origin_provider", "eu_origin_registry_id", "eu_origin_document_url", "eu_origin_status",
  "eu_origin_verified_at", "eu_origin_country",
  "weee_number", "wee_number", "weee", "wee", "eprel_number", "eprel", "eprel_id", "eprel_registration_number",
  "product_files", "files",
]);

export function isSystemMetaobjectKey(raw) {
  const key = slugifyMetaKey(raw);
  if (!key || key.startsWith("_")) return true;
  if (SYSTEM_METAOBJECT_KEYS.has(key)) return true;
  if (key.endsWith("_id") || key.endsWith("_ids")) return true;
  if (/(^|_)(weee?|eprel|bullet|hersteller|manufacturer|gpsr)(_|$)/i.test(key)) return true;
  if (key.includes("bullet_point")) return true;
  return false;
}

/** Slugify + if reserved, prefix with attr_ (e.g. type → attr_type). */
export function resolveSafeMetaobjectKey(raw) {
  let key = slugifyMetaKey(raw);
  if (!key) return "";
  if (!isSystemMetaobjectKey(key)) return key;
  const prefixed = slugifyMetaKey(`attr_${key}`);
  if (prefixed && !isSystemMetaobjectKey(prefixed)) return prefixed;
  return "";
}

export function getMetaobjectsCopy(locale) {
  const t = (en, tr, fr, es, it, de) => lt(locale, en, tr, fr, es, it, de);
  return {
    loadError: t("Error loading data", "Veri yüklenemedi", "Erreur de chargement", "Error al cargar", "Errore di caricamento", "Fehler beim Laden"),
    saveError: t("Save error", "Kaydetme hatası", "Erreur d'enregistrement", "Error al guardar", "Errore di salvataggio", "Speicherfehler"),
    keyRequired: t("Key is required", "Anahtar zorunlu", "La clé est requise", "La clave es obligatoria", "La chiave è obbligatoria", "Key ist erforderlich"),
    keyExists: t("This key already exists", "Bu anahtar zaten var", "Cette clé existe déjà", "Esta clave ya existe", "Questa chiave esiste già", "Dieser Key existiert bereits"),
    approvalFailed: t("Approval failed", "Onay başarısız", "Approbation échouée", "Aprobación fallida", "Approvazione non riuscita", "Freigabe fehlgeschlagen"),
    editApprovalFailed: t("Edit/approval failed", "Düzenleme/onay başarısız", "Modification/approbation échouée", "Edición/aprobación fallida", "Modifica/approvazione non riuscita", "Bearbeiten/Freigabe fehlgeschlagen"),
    rejectionFailed: t("Rejection failed", "Reddetme başarısız", "Rejet échoué", "Rechazo fallido", "Rifiuto non riuscito", "Ablehnen fehlgeschlagen"),
    editPrompt: t("Edit values (comma-separated) and approve:", "Değerleri düzenle (virgülle ayır) ve onayla:", "Modifier les valeurs (séparées par des virgules) et approuver :", "Editar valores (separados por comas) y aprobar:", "Modifica valori (separati da virgole) e approva:", "Werte bearbeiten (Komma getrennt) und freigeben:"),
    pageTitle: t("Meta objects", "Meta nesneler", "Méta-objets", "Metaobjetos", "Meta oggetti", "Metaobjekte"),
    pageSubtitle: t("Define reusable attributes for your products", "Ürünlerin için yeniden kullanılabilir özellikler tanımla", "Définissez des attributs réutilisables pour vos produits", "Define atributos reutilizables para tus productos", "Definisci attributi riutilizzabili per i tuoi prodotti", "Definiere wiederverwendbare Attribute für deine Produkte"),
    newDefinition: t("New definition", "Yeni tanım", "Nouvelle définition", "Nueva definición", "Nuova definizione", "Neue Definition"),
    sellerBanner: t("As a seller, you can propose new catalog meta fields from the product editor. This page shows the shared catalog; editing and approvals are reserved for superusers.", "Satıcı olarak ürün düzenleme bölümünden yeni katalog meta alanları önerebilirsin. Bu sayfa ortak kataloğu gösterir; düzenleme ve onaylar süper kullanıcılara ayrılmıştır.", "En tant que vendeur, vous pouvez proposer de nouveaux champs méta depuis l'édition du produit.", "Como vendedor, puedes proponer nuevos campos meta desde la edición de productos.", "Come venditore, puoi proporre nuovi campi meta dalla modifica del prodotto.", "Als Verkäufer kannst du neue Katalog-Metafelder in der Produktbearbeitung vorschlagen. Bearbeiten und Freigaben sind für Superuser reserviert."),
    pendingHeading: t("Pending approvals (Seller proposals)", "Bekleyen onaylar (Satıcı önerileri)", "Approbations en attente (Propositions vendeur)", "Aprobaciones pendientes (Propuestas del vendedor)", "Approvazioni in sospeso (Proposte del venditore)", "Ausstehende Freigaben (Verkäufer-Vorschläge)"),
    pendingHelp: t("After approval, the key and values appear in the catalog and product selection.", "Onaylandıktan sonra anahtar ve değerler katalogda ve ürün seçiminde görünür.", "Après approbation, la clé et les valeurs apparaissent dans le catalogue.", "Tras la aprobación, la clave y los valores aparecen en el catálogo.", "Dopo l'approvazione, chiave e valori compaiono nel catalogo.", "Nach Genehmigung erscheinen Key und Werte im Katalog und in der Produktauswahl."),
    seller: t("Seller", "Satıcı", "Vendeur", "Vendedor", "Venditore", "Verkäufer"),
    approve: t("Approve", "Onayla", "Approuver", "Aprobar", "Approva", "Genehmigen"),
    editApprove: t("Edit + Approve", "Düzenle + Onayla", "Modifier + Approuver", "Editar + Aprobar", "Modifica + Approva", "Bearbeiten + Genehmigen"),
    reject: t("Reject", "Reddet", "Rejeter", "Rechazar", "Rifiuta", "Ablehnen"),
    emptyHeading: t("No definitions yet", "Henüz tanım yok", "Aucune définition pour l'instant", "Sin definiciones aún", "Nessuna definizione ancora", "Noch keine Definitionen"),
    createFirst: t("Create first definition", "İlk tanımı oluştur", "Créer la première définition", "Crear primera definición", "Crea la prima definizione", "Erste Definition erstellen"),
    emptySuperuser: t('Create attribute definitions like "Color" or "Material" and add reusable values.', '"Renk" veya "Malzeme" gibi özellik tanımları oluştur ve yeniden kullanılabilir değerler ekle.', 'Créez des définitions comme "Couleur" ou "Matière".', 'Crea definiciones como "Color" o "Material".', 'Crea definizioni come "Colore" o "Materiale".', 'Erstelle Attribut-Definitionen wie "Farbe" oder "Material" und füge wiederverwendbare Werte hinzu.'),
    emptySeller: t("New meta fields are created in the product editor (Title + Value); a superuser approves them here.", "Yeni meta alanları ürün düzenleme bölümünden oluşturulur; süper kullanıcı burada onaylar.", "Les nouveaux champs méta se créent dans l'édition produit ; un superutilisateur les approuve ici.", "Los nuevos campos meta se crean en la edición del producto; un superusuario los aprueba aquí.", "I nuovi campi meta si creano nell'editor prodotto; un superutente li approva qui.", "Neue Metafelder legst du in der Produktbearbeitung an; ein Superuser gibt sie hier frei."),
    value: t("value", "değer", "valeur", "valor", "valore", "Wert"),
    values: t("values", "değer", "valeurs", "valores", "valori", "Werte"),
    addValue: t("Value", "Değer", "Valeur", "Valor", "Valore", "Wert"),
    noValues: t("No values yet.", "Henüz değer yok.", "Aucune valeur pour l'instant.", "Sin valores aún.", "Nessun valore ancora.", "Noch keine Werte."),
    clickAddValue: t("Click + Value to add the first one.", "+ Değer ile ilkini ekle.", "Cliquez sur + Valeur pour ajouter le premier.", "Haz clic en + Valor para añadir el primero.", "Fai clic su + Valore per aggiungere il primo.", "Klicke auf + Wert, um den ersten hinzuzufügen."),
    howTitle: t("How does this work?", "Bu nasıl çalışır?", "Comment ça fonctionne ?", "¿Cómo funciona?", "Come funziona?", "Wie funktioniert das?"),
    howDefine: t("Define attributes like Color, Material or Size and add predefined values.", "Renk, Malzeme veya Beden gibi özellikler tanımla ve önceden tanımlı değerler ekle.", "Définissez des attributs comme Couleur, Matière ou Taille.", "Define atributos como Color, Material o Talla.", "Definisci attributi come Colore, Materiale o Taglia.", "Definiere Attribute wie Farbe, Material oder Größe und füge vordefinierte Werte hinzu."),
    howDropdown: t("In the product editor, you can select these values via a dropdown — quickly and consistently.", "Ürün düzenleyicide bu değerleri açılır listeden seçebilirsin.", "Dans l'éditeur produit, sélectionnez ces valeurs via un menu déroulant.", "En el editor de productos, selecciona estos valores con un desplegable.", "Nell'editor prodotto, seleziona questi valori da un menu a discesa.", "Im Produkt-Editor kannst du diese Werte per Dropdown auswählen — schnell und einheitlich."),
    howSeller: t("Sellers propose new keys/values in the product editor; superusers approve them on this page.", "Satıcılar ürün düzenleyicide yeni anahtar/değer önerir; süper kullanıcılar burada onaylar.", "Les vendeurs proposent de nouvelles clés/valeurs ; les superutilisateurs approuvent ici.", "Los vendedores proponen nuevas claves/valores; los superusuarios aprueban aquí.", "I venditori propongono nuove chiavi/valori; i superutenti approvano qui.", "Verkäufer schlagen neue Keys/Werte in der Produktbearbeitung vor; Superuser geben sie hier frei."),
    autoValues: t("Values from existing products are automatically displayed here.", "Mevcut ürünlerden gelen değerler otomatik olarak burada gösterilir.", "Les valeurs issues des produits existants sont automatiquement affichées ici.", "Los valores de los productos existentes se muestran automáticamente aquí.", "I valori dei prodotti esistenti vengono visualizzati automaticamente qui.", "Werte aus bestehenden Produkten werden automatisch hier angezeigt."),
    modalNewTitle: t("New definition", "Yeni tanım", "Nouvelle définition", "Nueva definición", "Nuova definizione", "Neue Definition"),
    fieldKey: t("Key (internal)", "Anahtar (dahili)", "Clé (interne)", "Clave (interna)", "Chiave (interna)", "Key (intern)"),
    fieldKeyHelp: t("Lowercase letters, numbers, underscores only", "Yalnızca küçük harf, rakam, alt çizgi", "Lettres minuscules, chiffres, underscores", "Solo minúsculas, números y guiones bajos", "Solo minuscole, numeri, underscore", "Nur Kleinbuchstaben, Zahlen, Unterstriche"),
    fieldLabel: t("Display label", "Görünen ad", "Libellé affiché", "Etiqueta visible", "Etichetta visualizzata", "Anzeigename"),
    fieldLabelHelp: t("Shown as filter title in the shop. Switch language above to translate.", "Shop’ta filtre başlığı olarak görünür. Çevirmek için yukarıdan dil seç.", "Affiché comme titre de filtre dans la boutique.", "Se muestra como título de filtro en la tienda.", "Mostrato come titolo filtro nello shop.", "Wird im Shop als Filtertitel angezeigt. Sprache oben wechseln zum Übersetzen."),
    valueTranslation: t("Translation", "Çeviri", "Traduction", "Traducción", "Traduzione", "Übersetzung"),
    valueCanonical: t("Catalog value (DE)", "Katalog değeri (DE)", "Valeur catalogue (DE)", "Valor de catálogo (DE)", "Valore catalogo (DE)", "Katalogwert (DE)"),
    language: t("Shop content language", "Shop içerik dili", "Langue du contenu boutique", "Idioma del contenido", "Lingua del contenuto shop", "Shop-Inhaltssprache"),
    translateValuesHint: t("Enter how each catalog value should appear in this language. Products keep the DE catalog value; only the shop filter label changes.", "Her katalog değerinin bu dilde nasıl görüneceğini gir. Ürünlerde DE değeri kalır; yalnızca shop filtre etiketi değişir.", "Saisissez l’affichage de chaque valeur dans cette langue.", "Introduce cómo debe verse cada valor en este idioma.", "Inserisci come deve apparire ogni valore in questa lingua.", "Gib an, wie jeder Katalogwert in dieser Sprache erscheinen soll. Produkte behalten den DE-Wert; nur die Shop-Filterbeschriftung ändert sich."),
    create: t("Create", "Oluştur", "Créer", "Crear", "Crea", "Erstellen"),
    cancel: t("Cancel", "İptal", "Annuler", "Cancelar", "Annulla", "Abbrechen"),
    modalAddValueTitle: t("Add value", "Değer ekle", "Ajouter une valeur", "Añadir valor", "Aggiungi valore", "Wert hinzufügen"),
    valuePh: t("e.g. Red", "ör. Kırmızı", "ex. Rouge", "p. ej. Rojo", "es. Rosso", "z. B. Rot"),
    add: t("Add", "Ekle", "Ajouter", "Añadir", "Aggiungi", "Hinzufügen"),
    importBtn: t("Import metaobjects", "Metaobject içe aktar", "Importer des méta-objets", "Importar metaobjetos", "Importa meta oggetti", "Metaobjekte importieren"),
    importTitle: t("Import metaobjects", "Metaobject içe aktar", "Importer des méta-objets", "Importar metaobjetos", "Importa meta oggetti", "Metaobjekte importieren"),
    importHelp: t(
      "Column order is always English, German, Turkish, French, Italian, Spanish. Each language has 2 columns: Title then Value. Existing titles receive new values (nothing is deleted). New titles are created.",
      "Sütun sırası her zaman İngilizce, Almanca, Türkçe, Fransızca, İtalyanca, İspanyolca. Her dilin 2 sütunu var: Title sonra Value. Mevcut başlıklara yeni değerler eklenir (silinmez).",
      "Ordre des colonnes : anglais, allemand, turc, français, italien, espagnol. 2 colonnes par langue : Title puis Value.",
      "Orden de columnas: inglés, alemán, turco, francés, italiano, español. 2 columnas por idioma: Title y Value.",
      "Ordine colonne: inglese, tedesco, turco, francese, italiano, spagnolo. 2 colonne per lingua: Title poi Value.",
      "Spaltenreihenfolge immer: Englisch, Deutsch, Türkisch, Französisch, Italienisch, Spanisch. Pro Sprache 2 Spalten: Title, dann Value. Vorhandene Titel erhalten neue Werte (nichts wird gelöscht).",
    ),
    downloadTemplate: t("Download .xlsx template", ".xlsx şablonunu indir", "Télécharger le modèle .xlsx", "Descargar plantilla .xlsx", "Scarica modello .xlsx", ".xlsx-Vorlage herunterladen"),
    dropLabel: t("Drop your .xlsx here or click to select", "xlsx dosyasını buraya bırakın veya seçin", "Déposez le .xlsx ici ou cliquez pour choisir", "Suelta el .xlsx aquí o haz clic para elegir", "Trascina il .xlsx qui o clicca per scegliere", ".xlsx hierher ziehen oder zum Auswählen klicken"),
    dropHint: t(".xlsx • EN DE TR FR IT ES • Title + Value each", ".xlsx • EN DE TR FR IT ES • her dil Title + Value", ".xlsx • EN DE TR FR IT ES • Title + Value", ".xlsx • EN DE TR FR IT ES • Title + Value", ".xlsx • EN DE TR FR IT ES • Title + Value", ".xlsx • EN DE TR FR IT ES • Title + Value je Sprache"),
    importAction: t("Import", "İçe aktar", "Importer", "Importar", "Importa", "Importieren"),
    importing: t("Importing…", "İçe aktarılıyor…", "Import…", "Importando…", "Importazione…", "Importiere…"),
    importOk: (created, updated, valuesAdded) => t(
      `Imported: ${created} new titles, ${updated} updated, ${valuesAdded} values added.`,
      `İçe aktarıldı: ${created} yeni başlık, ${updated} güncellendi, ${valuesAdded} değer eklendi.`,
      `Importé : ${created} nouveaux titres, ${updated} mis à jour, ${valuesAdded} valeurs ajoutées.`,
      `Importado: ${created} títulos nuevos, ${updated} actualizados, ${valuesAdded} valores añadidos.`,
      `Importato: ${created} nuovi titoli, ${updated} aggiornati, ${valuesAdded} valori aggiunti.`,
      `Importiert: ${created} neue Titel, ${updated} aktualisiert, ${valuesAdded} Werte ergänzt.`,
    ),
    importFail: t("Import failed", "İçe aktarma başarısız", "Échec de l’import", "Error al importar", "Importazione non riuscita", "Import fehlgeschlagen"),
    chooseFile: t("Choose a file first.", "Önce bir dosya seçin.", "Choisissez d’abord un fichier.", "Elige un archivo primero.", "Scegli prima un file.", "Bitte zuerst eine Datei wählen."),
    pendingBadge: (n) => t(
      `${n} pending approval${n === 1 ? "" : "s"}`,
      `${n} bekleyen onay`,
      `${n} approbation${n === 1 ? "" : "s"} en attente`,
      `${n} aprobación${n === 1 ? "" : "es"} pendiente${n === 1 ? "" : "s"}`,
      `${n} approvazione${n === 1 ? "" : "i"} in sospeso`,
      `${n} ausstehende Freigabe${n === 1 ? "" : "n"}`,
    ),
    pendingModalTitle: t("Pending approvals", "Bekleyen onaylar", "Approbations en attente", "Aprobaciones pendientes", "Approvazioni in sospeso", "Ausstehende Freigaben"),
    searchTitles: t("Search titles…", "Başlık ara…", "Rechercher des titres…", "Buscar títulos…", "Cerca titoli…", "Titel suchen…"),
    titles: t("Titles", "Başlıklar", "Titres", "Títulos", "Titoli", "Titel"),
    selectTitle: t("Select a title on the left to see its values.", "Değerleri görmek için soldan bir başlık seçin.", "Sélectionnez un titre à gauche pour voir ses valeurs.", "Selecciona un título a la izquierda para ver sus valores.", "Seleziona un titolo a sinistra per vedere i valori.", "Wähle links einen Titel, um die Werte zu sehen."),
    editTitle: t("Edit title", "Başlığı düzenle", "Modifier le titre", "Editar título", "Modifica titolo", "Titel bearbeiten"),
    editValue: t("Edit value", "Değeri düzenle", "Modifier la valeur", "Editar valor", "Modifica valore", "Wert bearbeiten"),
    langPicker: t("Language", "Dil", "Langue", "Idioma", "Lingua", "Sprache"),
    langHelp: t("Switch language and enter the matching translation. The shop shows the visitor’s language.", "Dil seçin ve o dildeki karşılığı yazın. Shop, ziyaretçinin dilini gösterir.", "Changez de langue et saisissez la traduction. La boutique affiche la langue du visiteur.", "Cambia el idioma e introduce la traducción. La tienda muestra el idioma del visitante.", "Cambia lingua e inserisci la traduzione. Lo shop mostra la lingua del visitatore.", "Sprache wechseln und die passende Übersetzung eintragen. Der Shop zeigt die Sprache des Besuchers."),
    catalogLangHint: t("German is the catalog language stored on products. Other languages are shop labels only.", "Almanca ürünlerde saklanan katalog dilidir. Diğer diller yalnızca shop etiketidir.", "L’allemand est la langue catalogue des produits. Les autres langues sont des libellés boutique.", "El alemán es el idioma de catálogo en productos. Los demás son etiquetas de tienda.", "Il tedesco è la lingua catalogo nei prodotti. Le altre sono etichette shop.", "Deutsch ist die Katalogsprache in den Produkten. Andere Sprachen sind nur Shop-Beschriftungen."),
    noMatch: t("No titles match your search.", "Aramanıza uyan başlık yok.", "Aucun titre ne correspond.", "Ningún título coincide.", "Nessun titolo corrisponde.", "Keine Titel passen zur Suche."),
  };
}
