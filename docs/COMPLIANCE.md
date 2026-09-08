# Compliance-Profilsystem (GPSR / WEEE / EPREL / …)

> ⚠️ **Das hier ist keine Rechtsberatung.** Bevor dieses System live geschaltet wird bzw. bevor
> daraus eine echte Verkaufssperre wird, muss ein Anwalt oder ein zugelassener Compliance-Berater
> die Profile, Pflichtfelder und Länder-Overlays prüfen. Die Inhalte dieser Datei sind eine
> technische Zusammenfassung dessen, was im Code implementiert ist — kein juristisches Gutachten.

Siehe auch `docs/HUKUKI.md` für die ursprüngliche Analyse und den Implementierungsverlauf
(Faz 1–4) dieses Systems.

## 1. Das Modell: drei Schichten

```
Kategorie  →  compliance_profile_id  →  Pflichtfelder (Basis)
                                      +  Marketplace-Overlay (Land)  →  zusätzliche Pflichtfelder
                                      +  manuelle Kategorie-Felder    →  superuser-definierte Extras
```

1. **Profil (Produkttyp)** — z. B. „Elektro-/Elektronikgerät" verlangt `weee_number`, „Kosmetik"
   verlangt eine INCI-Liste. Jede Kategorie hat genau ein wirksames Profil, das entweder direkt
   gesetzt oder von der nächsten übergeordneten Kategorie geerbt wird (Fallback:
   `general_consumer_gpsr`).
2. **Marketplace-Overlay (Land)** — legt zusätzliche, länderspezifische Felder obenauf, z. B. eine
   deutsche WEEE-Registrierungsnummer nur dann, wenn das Basisprofil ohnehin schon WEEE verlangt.
   Verhindert falsche Treffer wie „Bücher brauchen WEEE".
3. **Manuelle Kategorie-Felder** (`/content/compliance-profiles`) — ein Superuser kann pro
   Kategorie zusätzliche, frei definierte Pflichtfelder anlegen, die die 15 Standardprofile nicht
   abdecken. Diese Felder werden **nicht** an Unterkategorien vererbt — jede Kategorie bekommt ihre
   eigene, explizite Liste.

Alle drei Schichten fließen zu einer einzigen Liste `required_fields` zusammen und werden im
Rechtlich-Tab des Sellercentral-Produkteditors angezeigt (siehe `ComplianceFieldsSection.jsx`).
Ein Feld erscheint dort **nur**, wenn es aus einer dieser drei Quellen kommt — nichts wird "auf
Verdacht" gezeigt.

## 2. Die 15 Basisprofile

| Profil-ID | Beschreibung | Erbt von | Pflichtfelder (zusätzlich zu GPSR) |
|---|---|---|---|
| `general_consumer_gpsr` | Allgemeine Verbraucherprodukte (Basis für fast alle anderen) | — | Hersteller, Herstellerinformationen, Verantwortliche Person (EU) |
| `electronics_weee` | Elektro-/Elektronikgeräte | general_consumer_gpsr | WEEE-Nummer |
| `energy_labeled_eprel` | Energieverbrauchskennzeichnung (Weißware, TV, Klima …) | electronics_weee | EPREL-Nummer |
| `battery_containing` | Batterien / Akkus | general_consumer_gpsr | Batteriechemie, Kapazität (Wh) |
| `cosmetics` | Kosmetik | general_consumer_gpsr | INCI-Liste, verantwortliche Person (Kosmetik) |
| `food` | Lebensmittel (LMIV) | general_consumer_gpsr | Zutaten, Allergene, MHD, Nährwerte |
| `food_supplement` | Nahrungsergänzungsmittel | food | Tagesdosis, Warnhinweis |
| `toys` | Spielzeug (2009/48/EG, EN71) | general_consumer_gpsr | CE-Konformitätserklärung, Altersempfehlung |
| `textiles` | Textilien / Bekleidung | general_consumer_gpsr | Faserzusammensetzung |
| `chemicals_reach` | Chemikalien (REACH/CLP) | general_consumer_gpsr | Sicherheitsdatenblatt (SDB) |
| `books_media` | Bücher / Medien | general_consumer_gpsr | — (nur Basis-GPSR) |
| `digital_goods` | Digitale Produkte / Downloads | — (kein GPSR) | — |
| `nicotine_tpd` | Nikotinprodukte (TPD) | general_consumer_gpsr | TPD-Referenz, Altersverifikation |
| `medical_device` | Medizinprodukt (MDR 2017/745) | general_consumer_gpsr | CE-Klasse, UDI, Bevollmächtigter — **`superuser_only`**, hohes Risiko auf einem Marktplatz |
| `ce_marked_general` | CE-pflichtige Produkte (allgemein) | general_consumer_gpsr | CE-Konformitätserklärung |

Quelle der Wahrheit: `apps/medusa-backend/src/compliance/compliance-profiles.json`
(`field_definitions` enthält Typ, i18n-Label und Hilfetext für jedes einzelne Feld in 6 Sprachen).

## 3. Marketplace-Overlays (Länder)

9 Overlays: `EU` (Basis, keine Extras), `DE`, `FR`, `IT`, `ES`, `AT`, `NL`, `PL`, `SE`.

Jedes Overlay kann:
- `extra_required_fields` — immer zusätzlich zum Basisprofil verlangen (aktuell ungenutzt, alle 0).
- `national_register_fields` — **bedingt** verlangen: nur wenn das Basisprofil das auslösende Feld
  bereits fordert. Beispiel: `weee_number_fr` wird nur verlangt, wenn das Profil ohnehin
  `weee_number` verlangt — ein Buch in Frankreich wird also nicht fälschlich nach einer
  WEEE-Nummer gefragt.
- `label_language` — die Sprache, in der die Produktbeschriftung laut Landesrecht vorliegen muss
  (z. B. `de` für Deutschland/Österreich, `fr` für Frankreich). Wird aktuell nur als Metadatum
  geführt; ein Hinweis dazu erscheint im Rechtlich-Tab, wenn das Profil sonstige Pflichtfelder hat.

Quelle: `apps/medusa-backend/src/compliance/marketplace-overlays.json`.

## 4. Wo das im Code lebt

| Zweck | Datei |
|---|---|
| Profile + Felddefinitionen | `apps/medusa-backend/src/compliance/compliance-profiles.json` |
| Länder-Overlays | `apps/medusa-backend/src/compliance/marketplace-overlays.json` |
| Auflösungs-Engine (Vererbung + Overlay-Merge) | `apps/medusa-backend/src/compliance/resolve-compliance.js` |
| Kategorie → Profil-Zuordnung (Ahnen-Kette) | `apps/medusa-backend/src/compliance/category-profile-lookup.js` |
| REST-Endpoint (Sellercentral fragt das für ein Produkt ab) | `GET /admin-hub/categories/:id/compliance-schema?marketplace=DE` |
| Manuelle Zuordnung/Override je Kategorie (Superuser-UI) | `apps/sellercentral/src/components/pages/ComplianceProfilesPage.jsx` (`/content/compliance-profiles`) |
| Nicht-blockierende Prüfliste (welche Produkte haben Lücken) | `apps/sellercentral/src/components/pages/ComplianceReviewPage.jsx` (`/content/compliance-review`) |
| Dynamische Felder im Produkteditor | `apps/sellercentral/src/components/products/ComplianceFieldsSection.jsx` |
| Shop-Anzeige der ausgefüllten Felder | `apps/shop/src/lib/prop-labels.js`, `ProductTemplate(.Mobile).jsx` |

## 5. Was aktuell blockiert und was nicht

- **Hart blockierend (verhindert Speichern):** nur die drei Basis-GPSR-Felder (Hersteller,
  Herstellerinformationen, Verantwortliche Person) — für **jedes** Produkt, unabhängig vom Profil.
  Das ist historisch bedingt (`validateRequiredGpsrForProduct` in `admin-products.js`) und wurde
  **bewusst nicht** auf „nur wenn das Profil es verlangt" umgestellt: die Kategorie→Profil-Zuordnung
  basiert auf einer automatischen Schlüsselwortsuche (siehe unten) und ist nicht zu 100 % sicher —
  eine harte Sperre auf dieser Basis könnte Verkäufer fälschlich blockieren.
- **Nicht blockierend (nur Hinweis):** alles andere — WEEE, EPREL, kategorie-spezifische und manuell
  hinzugefügte Felder. Fehlt etwas, wird das Produkt trotzdem gespeichert/veröffentlicht; es taucht
  stattdessen unter `/content/compliance-review` auf, gruppiert nach Kategorie, damit ein Superuser
  es gezielt nachpflegen kann.
- **Zweiter Verkäufer, gleiches EAN:** Ein Produkt mit derselben EAN wird nicht als komplett neues
  Produkt angelegt, sondern als zusätzlicher Eintrag in `admin_hub_seller_listings` auf das
  bestehende, gemeinsame Produkt — die GPSR-/Compliance-Daten liegen zentral auf diesem einen
  Produkt-Datensatz, ein zweiter Verkäufer muss sie also nicht erneut eingeben.

## 6. Bekannte Grenzen / bewusst offen gelassen

- Die initiale Kategorie→Profil-Zuordnung (12.337 Kategorien) beruht auf einer
  Schlüsselwort-Heuristik, nicht auf manueller Prüfung jeder einzelnen Kategorie. ~33 % der
  Kategorien fielen mangels Treffer auf `general_consumer_gpsr` zurück. Korrekturen erfolgen laufend
  über `/content/compliance-profiles`.
- Excel-Massenimport (`sellercentral/api/import-export/import`) läuft über dieselben
  Create/Update-Endpunkte wie die manuelle Produktpflege — die nicht-blockierende
  Compliance-Prüfung greift dadurch automatisch mit, ohne eigene Import-spezifische Logik.
- EPREL-Nummern sind aktuell reiner Text, kein anklickbarer Link zur EPREL-Datenbank (das offizielle
  URL-Format ist kategorieabhängig und wurde nicht sicher genug verifiziert, um ein falsches Linkziel
  zu riskieren).
- Der Übergang von „nur Hinweis" zu „harte Sperre" (siehe Abschnitt 5) ist eine spätere,
  bewusste Entscheidung — nicht vor einer manuellen Nachbesserung der Kategorie-Zuordnung und einer
  Beobachtungsphase der `compliance-review`-Daten empfohlen.
