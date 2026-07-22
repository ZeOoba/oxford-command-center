// server/sources/notion-tenants.ts
//
// Live Notion "Tenant Database" adapter — fetches tenant/lease rows for cross-checking against
// the Master Workbook (see server/reconcile/lease-source-reconciliation.ts). Mirrors the
// notion-deals.ts pattern: graceful with no NOTION_TOKEN (or on any error) → empty array, so a
// reconciliation run degrades to "nothing to compare" rather than failing.
import type { NotionTenantLease } from '../reconcile/lease-source-reconciliation';

// Verified via the Notion connection 2026-07-21: DB "Tenant Database" (page id
// 8dbbaec0611a4617be076a77d0d0307a; database id b12f4cfda995475583416435ae8173b4), single data
// source as of that verification (id below) — but discovered fresh on every call (like
// notion-deals.ts) rather than assumed, in case it ever becomes multi-source.
const TENANT_DB_ID = process.env.NOTION_TENANT_DB ?? 'b12f4cfda995475583416435ae8173b4';
const NOTION_VERSION = process.env.NOTION_VERSION ?? '2025-09-03';
const NOTION = 'https://api.notion.com/v1';

const notionHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'notion-version': NOTION_VERSION,
  'content-type': 'application/json',
});

interface NotionPage { properties?: Record<string, unknown> }

const title = (p: Record<string, unknown>, k: string): string => {
  const v = p[k] as { title?: Array<{ plain_text?: string }> } | undefined;
  return (v?.title ?? []).map((t) => t.plain_text ?? '').join('').trim();
};
const text = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const s = (v?.rich_text ?? []).map((t) => t.plain_text ?? '').join('').trim();
  return s || null;
};
const select = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { select?: { name?: string } | null } | undefined;
  return v?.select?.name ?? null;
};
const dateProp = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { date?: { start?: string | null } | null } | undefined;
  return v?.date?.start ?? null;
};

/** Exported for tests. */
export function mapNotionTenantPage(page: NotionPage): NotionTenantLease | null {
  const p = page.properties ?? {};
  const tenantName = title(p, 'Tenant Name');
  if (!tenantName) return null;
  return {
    tenantName,
    propertyAddress: text(p, 'Property Address'),
    leaseStatus: select(p, 'Lease Status'),
    leaseStart: dateProp(p, 'Lease Start'),
    leaseEnd: dateProp(p, 'Lease Expiration'),
  };
}

/** Resolve the tenant database's data source id(s), mirroring notion-deals.ts. Env override
 *  skips the discovery call. */
async function resolveDataSourceIds(token: string): Promise<string[]> {
  const override = process.env.NOTION_TENANT_DATA_SOURCE;
  if (override) return override.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch(`${NOTION}/databases/${TENANT_DB_ID}`, { headers: notionHeaders(token) });
  if (!res.ok) throw new Error(`Notion db ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const db = (await res.json()) as { data_sources?: Array<{ id?: string }> };
  return (db.data_sources ?? []).map((d) => d.id).filter((x): x is string => !!x);
}

async function fetchNotionTenants(token: string): Promise<NotionTenantLease[]> {
  const dataSourceIds = await resolveDataSourceIds(token);
  if (!dataSourceIds.length) throw new Error('Notion: no data sources on tenant database');
  const rows: NotionTenantLease[] = [];
  let totalPages = 0;
  for (const dsId of dataSourceIds) {
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${NOTION}/data_sources/${dsId}/query`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
      });
      if (!res.ok) throw new Error(`Notion ds ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = (await res.json()) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string };
      for (const page of data.results ?? []) {
        totalPages++;
        const t = mapNotionTenantPage(page);
        if (t) rows.push(t);
      }
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  // Silent-drop safeguard: mapNotionTenantPage returns null for any row with no usable "Tenant
  // Name" (e.g. a schema/property-name drift) — a "successful" fetch that keeps zero of a
  // non-trivial page set would otherwise look identical to a genuinely empty database, and a
  // reconciliation run would report "0 divergences" as if everything checked out.
  if (totalPages > 0 && rows.length === 0) {
    console.warn(`[notion-tenants] fetched ${totalPages} page(s) but mapped 0 usable tenant rows — check the Notion property names this adapter expects ("Tenant Name", "Property Address", "Lease Status", "Lease Start", "Lease Expiration") against the live schema.`);
  }
  return rows;
}

/** The tenant source: live Notion when configured, else empty (reconciliation reports nothing
 *  to compare rather than failing — this is a read-only cross-check, not a hard dependency). */
export async function loadNotionTenants(): Promise<NotionTenantLease[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) return [];
  try {
    return await fetchNotionTenants(token);
  } catch (e) {
    console.warn(`[notion-tenants] live fetch failed, treating as unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
