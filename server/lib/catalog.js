import { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalize } from './partNumber.js';

let pool;

const MAX_CACHE_ENTRIES = 2000
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map() // key -> { value, cachedAt }

function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) { cache.delete(key); return undefined }
  cache.delete(key); cache.set(key, entry) // bump recency
  return entry.value
}
function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
  cache.set(key, { value, cachedAt: Date.now() })
}

function db() {
  if (!pool) {
     if (!process.env.DATABASE_URL) {
       throw new Error('DATABASE_URL must be configured for the vendor catalog.');
     }
     
     pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl:
                process.env.DATABASE_SSL === 'true'
                    ? { rejectUnauthorized: false }
                    : undefined,
        });
    }

  return pool;
}

export async function initCatalog() {
    await db().query(
        await fs.readFile(path.resolve('server/db/schema.sql'), 'utf8')
    );
}

function mapPart(row) {
    return {
        id: row.id,
        canonicalPartNumber: row.canonical_part_number,
        originalPartNumber:
            row.original_part_number || row.canonical_part_number,
        description: row.description,
        vendorAgnostic: row.vendor_agnostic,
        vendorUnknown: row.vendor_unknown,
        aliases: row.aliases || [],
        listings: row.listings || [],
    };
}

export async function listCatalog({
    search = '',
    limit = 100,
    offset = 0,
} = {}) {
    const { rows } = await db().query(
        `
            SELECT p.*,
                COALESCE(
                    json_agg(DISTINCT a.alias)
                    FILTER (WHERE a.id IS NOT NULL),
                    '[]'
                ) AS aliases,
                COALESCE(
                    json_agg(
                        DISTINCT jsonb_build_object(
                            'id', v.id,
                            'vendorName', v.vendor_name,
                            'vendorPartNumber', v.vendor_part_number,
                            'purchaseUrl', v.purchase_url,
                            'latestPrice', v.latest_price,
                            'currency', v.currency,
                            'availability', v.availability,
                            'isDefault', v.is_default,
                            'active', v.active
                        )
                    ) FILTER (WHERE v.id IS NOT NULL),
                    '[]'
                ) AS listings
            FROM catalog_parts p
            LEFT JOIN part_aliases a
                ON a.catalog_part_id = p.id
            LEFT JOIN vendor_listings v
                ON v.catalog_part_id = p.id
            WHERE (
                $1 = ''
                OR p.canonical_part_number ILIKE $2
                OR p.description ILIKE $2
                OR v.vendor_name ILIKE $2
                OR v.vendor_part_number ILIKE $2
            )
            GROUP BY p.id
            ORDER BY p.canonical_part_number
            LIMIT $3
            OFFSET $4
        `,
        [search, `%${search}%`, Math.min(limit, 500), offset]
    );

    return rows.map(mapPart);
}

export async function upsertCatalogPart(input) {
    const client = await db().connect();

    try {
        await client.query('BEGIN');

        const pn = normalize(input.canonicalPartNumber);

        if (!pn) {
            throw new Error('Onshape Part Number is required.');
        }

        const part = (
            await client.query(
                `
                    INSERT INTO catalog_parts (
                        canonical_part_number,
                        description,
                        vendor_agnostic,
                        vendor_unknown
                    )
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (canonical_part_number)
                    DO UPDATE SET
                        description = COALESCE(
                            EXCLUDED.description,
                            catalog_parts.description
                        ),
                        vendor_agnostic = EXCLUDED.vendor_agnostic,
                        vendor_unknown = EXCLUDED.vendor_unknown,
                        updated_at = now()
                    RETURNING *
                `,
                [
                    pn,
                    input.description || null,
                    !!input.vendorAgnostic,
                    !!input.vendorUnknown,
                ]
            )
        ).rows[0];

        for (const alias of input.aliases || []) {
            const a = normalize(alias);

            if (a) {
                await client.query(
                    `
                        INSERT INTO part_aliases (
                            catalog_part_id,
                            alias
                        )
                        VALUES ($1, $2)
                        ON CONFLICT DO NOTHING
                    `,
                    [part.id, a]
                );
            }
        }

        for (const x of input.listings || []) {
            if (!x.vendorName || !x.vendorPartNumber) {
                continue;
            }

            const listingResult = await client.query(
                `
                    INSERT INTO vendor_listings (
                        catalog_part_id,
                        vendor_name,
                        vendor_part_number,
                        purchase_url,
                        latest_price,
                        currency,
                        availability,
                        is_default,
                        active
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        COALESCE(NULLIF($6, ''), 'USD'),
                        $7,
                        $8,
                        $9
                    )
                    ON CONFLICT (
                        catalog_part_id,
                        vendor_name,
                        vendor_part_number
                    )
                    DO UPDATE SET
                        purchase_url = EXCLUDED.purchase_url,
                        latest_price = EXCLUDED.latest_price,
                        currency = EXCLUDED.currency,
                        availability = EXCLUDED.availability,
                        is_default = EXCLUDED.is_default,
                        active = EXCLUDED.active,
                        updated_at = now()
                    RETURNING id
                `,
                [
                    part.id,
                    x.vendorName,
                    x.vendorPartNumber,
                    x.purchaseUrl || null,
                    x.latestPrice || null,
                    x.currency || 'USD',
                    x.availability || null,
                    !!x.isDefault,
                    x.active !== false,
                ]
            );

            if (x.isDefault) {
                await client.query(
                    `UPDATE vendor_listings SET is_default = false WHERE catalog_part_id = $1 AND id <> $2`,
                    [part.id, listingResult.rows[0].id]
                )
            }
        }

        await client.query('COMMIT');
        
        cache.clear();
        return part 
    } catch(e){
        await client.query('ROLLBACK');
    throw e
    } finally {
        client.release()
    } 
}

export async function deleteVendorListing(id) {
    const listingId = Number(id)
    if (!Number.isSafeInteger(listingId) || listingId <= 0) {
        throw new Error('A valid vendor listing id is required.')
    }

    const client = await db().connect()
    try {
        await client.query('BEGIN')

        const deleted = await client.query(
            'DELETE FROM vendor_listings WHERE id = $1 RETURNING catalog_part_id',
            [listingId]
        )

        if (!deleted.rowCount) {
            throw new Error('Vendor listing not found.')
        }

        const catalogPartId = deleted.rows[0].catalog_part_id
        const removedPart = await client.query(
            `DELETE FROM catalog_parts p
             WHERE p.id = $1
               AND NOT EXISTS (
                   SELECT 1 FROM vendor_listings v
                   WHERE v.catalog_part_id = p.id
               )`,
            [catalogPartId]
        )

        await client.query('COMMIT')
        cache.clear()
        return { id: listingId, partDeleted: !!removedPart.rowCount }
    } catch (e) {
        await client.query('ROLLBACK')
        throw e
    } finally {
        client.release()
    }
}
 
export async function findListing(partNumber) {
    const v = normalize(partNumber);

    if (!v) {
        return null;
    }

    const { rows } = await db().query(
        `
            SELECT
                v.id,
                v.vendor_name AS "vendorName",
                v.vendor_part_number AS "vendorPartNumber",
                v.purchase_url AS "purchaseUrl",
                v.latest_price AS "latestPrice",
                v.currency,
                v.availability,
                v.active,
                p.canonical_part_number AS "canonicalPartNumber"
            FROM vendor_listings v
            JOIN catalog_parts p
                ON p.id = v.catalog_part_id
            LEFT JOIN part_aliases a
                ON a.catalog_part_id = p.id
            WHERE v.active
              AND (
                  p.canonical_part_number = $1
                  OR a.alias = $1
              )
            ORDER BY v.is_default DESC, v.id
            LIMIT 1
        `,
        [v]
    );

    return rows[0] || null;
}

export async function findListings(partNumber) {
    const v = normalize(partNumber);

    if (!v) {
        return [];
    }

    const cached = cacheGet(v);
    if (cached !== undefined) {
        return cached;
    }

    const { rows } = await db().query(
        `
            SELECT
                v.id,
                v.vendor_name AS "vendorName",
                v.vendor_part_number AS "vendorPartNumber",
                v.purchase_url AS "purchaseUrl",
                v.latest_price AS "latestPrice",
                v.currency,
                v.availability,
                v.active,
                v.is_default AS "isDefault",
                p.canonical_part_number AS "canonicalPartNumber"
            FROM vendor_listings v
            JOIN catalog_parts p
                ON p.id = v.catalog_part_id
            LEFT JOIN part_aliases a
                ON a.catalog_part_id = p.id
            WHERE v.active
              AND (
                  p.canonical_part_number = $1
                  OR a.alias = $1
              )
            ORDER BY v.is_default DESC, v.id
        `,
        [v]
    );

    cacheSet(v, rows);

    return rows;
}

export async function findListingsBatch(partNumbers) {
    const unique = [
        ...new Set(
            (partNumbers || [])
                .map(normalize)
                .filter(Boolean)
        ),
    ];

    const result = {};

    await Promise.all(
        unique.map(async (p) => {
            result[p] = await findListings(p);
        })
    );

    return result;
}

export function clearCatalogCache() {
    cache.clear();
}
