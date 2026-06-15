# OM Upload & Field Extraction — Design Spec
*2026-06-14 · Acquisition Workbench feature*

## Problem

The Acquisition Workbench requires manually entering 36 fields. Offering Memoranda (OMs) contain many of these values — price, SF, year built, clear height, dock count, rent, WALT, etc. — but extracting them by hand is slow and error-prone. This feature lets Gabriel upload an OM PDF and auto-populate eligible fields in one step, with a review gate before anything touches the form.

## Decisions Made

| Question | Decision |
|---|---|
| Upload placement | "Upload OM" button in the topbar header, next to PREFILL FROM dropdown |
| Review UI | Collapsible drawer with mini table (field · extracted value · ✓) |
| Apply behavior | Overwrites all extracted fields — no skip-if-filled merge |
| File persistence | Transient only — never added to RAG corpus |
| Conflict with existing values | User sees the table before applying; apply always overwrites |
| Extraction engine | Claude API (server-side, same infrastructure as existing AI tools) |

## Architecture

### New files

**`server/warehouse/om-extract.ts`**
Extraction logic. Responsibilities:
- Accept raw PDF `Buffer`
- Extract text via `pdf-parse` (already a project dependency)
- Parse the PDF `Buffer` directly in memory (no temp file written)
- Build a field-manifest prompt listing all 36 extractable field names with their expected format and OM synonyms
- Call Claude API, request JSON output in `Partial<FormState>` format (string-keyed, display values — same format the form uses internally, e.g. `"price": "1450000"`, `"officePct": "15"`)
- Instruct Claude: omit fields not found with high confidence; never guess
- Parse and validate the response; return `{ fields: Partial<FormState>, fieldCount: number }`

**`src/modules/acquisitions/OmImportDrawer.tsx`**
UI component. Props:
```ts
interface OmImportDrawerProps {
  open: boolean;
  onClose: () => void;
  onApply: (fields: Partial<FormState>) => void;
}
```
Internal states: `idle | uploading | extracted | error`

Renders:
- **uploading**: progress bar + filename + "Extracting fields…" label
- **extracted**: mini table (field label · extracted value · ✓ checkmark), filename, field count, "Discard" + "Apply to Form" buttons
- **error**: error message + "Try again" button

### Edited files

**`server/index.ts`**
New route: `POST /api/actions/om-extract`
- Parses multipart/form-data to get the PDF file
- Enforces `MAX_FILE_BYTES` size limit (reuse constant from `documents.ts`)
- Calls `om-extract.ts` extraction logic
- Returns `{ fields: Partial<FormState>, fieldCount: number }` or `{ error: string }` on failure

**`src/modules/acquisitions/acquisition-score.ts`**
New client helper `omExtractRequest(file: File): Promise<OmExtractResult>`:
- Posts multipart to `/api/actions/om-extract`
- Returns typed result or throws on network/server error
- Pattern mirrors existing `scoreDealRequest`

**`src/modules/acquisitions/AcquisitionWorkbench.tsx`**
- Add "Upload OM" button in the header row (between PREFILL FROM area and Save button)
- Manage `drawerOpen: boolean` state
- Render `<OmImportDrawer>` when `drawerOpen`
- `onApply` handler: `setForm(prev => ({ ...prev, ...extracted }))` — one line, same pattern as `dealToForm` prefill
- After apply: close drawer, scoring debounce fires automatically

**`tests/unit/om-extract.test.ts`** (new)
Unit tests:
- Field manifest prompt contains all expected field keys
- Valid JSON response → correct `Partial<FormState>` output
- Malformed JSON response → error returned, no crash
- Empty PDF text → `{ fields: {}, fieldCount: 0 }` (not an error)
- Oversized file → rejected before parsing

## Extractable Fields

These are the ~15 fields Claude can reliably find in a standard OM. All others require human judgment and are excluded from the extraction prompt.

| Group | Field key | OM synonyms |
|---|---|---|
| Size & Price | `price` | asking price, list price, offering price |
| Size & Price | `totalSf` | GBA, gross building area, building size, total SF |
| Size & Price | `maxBuildingSf` | largest building, max building SF (= totalSf for single-building) |
| Physical | `yearBuilt` | year built, constructed, vintage |
| Physical | `clearHeightFt` | clear height, clear ceiling height |
| Physical | `officePct` | office percentage, office buildout, office ratio |
| Physical | `constructionType` | masonry, tilt-up, block, PEMB, pre-engineered |
| Physical | `hasDock` | dock doors, loading docks, dock-high |
| Physical | `dockCount` | number of dock doors |
| Physical | `hasDriveIn` | drive-in doors, grade-level doors, drive-in access |
| Physical | `driveInCount` | number of drive-in doors |
| Physical | `truckCourtFt` | truck court depth, maneuvering depth |
| Financials | `inPlaceRentPsf` | current rent, in-place rent, contract rent ($/SF NNN) |
| Financials | `marketRentPsf` | market rent, asking rent ($/SF NNN) |
| Financials | `waltYears` | WALT, weighted average lease term, remaining lease term |

**Not extracted** (require judgment or not disclosed in OMs): `clusterTier`, `marketFundamentalsAdj`, `marketFundamentalsConfidence`, `sellerMotivationScore`, `valueAddScore`, `replacementCostBand`, `stabilizedYoc`, `leveredIrr`, `underwriteHorizonYrs`, `sfhaOnPad`, all `ddKnown` fields, `compSourcedAt`.

## Data Flow

```
User clicks "Upload OM"
  → file picker opens
  → user selects PDF
  → OmImportDrawer: state = uploading
  → POST /api/actions/om-extract (multipart, PDF buffer)
  → server: pdf-parse → text
  → server: Claude API call with field manifest + text
  → server: parse JSON response → Partial<FormState>
  → response: { fields, fieldCount }
  → OmImportDrawer: state = extracted, renders table
  → user reviews field · value · ✓ table
  → user clicks "Apply to Form"
  → AcquisitionWorkbench: setForm(prev => ({ ...prev, ...fields }))
  → drawer closes, 300ms debounce fires → scoring engine re-scores
```

## FormState Format for Extraction Response

Claude returns values in the same string format the form uses internally:
- Numbers as strings: `"price": "1450000"`, `"totalSf": "17688"`
- Percentages as display values (0–100): `"officePct": "15"`
- Tribools as `"yes"` / `"no"`: `"hasDock": "yes"`
- Enums as their code value: `"constructionType": "block-tilt-brick"`

This means `onApply` can merge directly into `FormState` with no conversion — the existing `buildInput` boundary handles the rest on the next score request.

## Error Handling

| Scenario | Behavior |
|---|---|
| File too large | Rejected client-side before upload; toast error |
| Non-PDF uploaded | Server returns `{ error: "unsupported file type" }`; drawer shows error state |
| pdf-parse returns empty text | Returns `{ fields: {}, fieldCount: 0 }` with drawer message "No extractable text found — is this a scanned/image PDF?" |
| Claude API unavailable | Server returns 503; drawer shows "Extraction service unavailable, try again" |
| Claude returns malformed JSON | Server catches parse error, returns 422; drawer shows error state |
| Network failure | Client catch → drawer error state + "Try again" button |

## Testing Strategy

- **Unit** (`tests/unit/om-extract.test.ts`): prompt shape, response parsing, error branches, empty-text path
- **Component** (`tests/unit/OmImportDrawer.test.tsx`): state transitions (idle → uploading → extracted → apply), discard path, error state render
- **Integration**: not required — the endpoint composes two already-tested primitives (pdf-parse + Claude API)

## Out of Scope

- Storing the OM in the document RAG corpus (separate decision; confidential deal docs should not pollute general search)
- Batch upload of multiple OMs
- Per-field confidence indicators or the ability to reject individual fields before applying
- OCR for scanned PDFs (image-only OMs return the empty-text error gracefully)
