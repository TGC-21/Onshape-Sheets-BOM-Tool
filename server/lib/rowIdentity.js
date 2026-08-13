// server/lib/rowIdentity.js — stable cross-import row identity (doc §6/§8.4).
import crypto from 'node:crypto'

// documentId::wvmType::wvmId::elementId::partIdentity::fullConfiguration.
// partIdentity (not partId) per doc §6 — stronger differentiator, and
// it's what Onshape itself uses to roll up repeated instances.
export function buildSourceKey(ref) {
  if (!ref?.documentId || !ref?.elementId) return null
  const partKey = ref.partIdentity || ref.partId
  if (!partKey) return null
  return [ref.documentId, ref.wvmType || 'w', ref.wvmId, ref.elementId, partKey, ref.fullConfiguration || ''].join('::')
}

export function contentHash(fields) {
  return crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16)
}

// Post-processes buildHierarchyRows() output: computes each row's
// sourceKey (falling back to a per-import-only synthetic key for rows
// missing enough ref data to trust — these can't diff correctly across
// syncs, which is an accepted edge case), resolves parentSourceKey via
// the existing rowId->sourceKey linkage, and a contentHash over the
// Onshape-owned fields (name/partNumber/quantity/level/parent — parent
// included since a part moving to a different subassembly is itself an
// Onshape-driven change).
export function annotateWithSourceKeys(rows) {
  const keyByRowId = new Map(rows.map((r) => [r.rowId, buildSourceKey(r.ref) ?? `fallback::${r.rowId}`]))
  return rows.map((r) => {
    const sourceKey = keyByRowId.get(r.rowId)
    const parent = r.parentRowId ? rows.find((candidate) => candidate.rowId === r.parentRowId) : null
    const parentSourceKey = parent ? keyByRowId.get(parent.rowId) : null
    const parentLabel = parent ? `${parent.partName}${parent.partNumber ? ` (${parent.partNumber})` : ''}` : ''
    const hash = contentHash([r.partName, r.partNumber, r.quantity, r.level, parentSourceKey])
    return { ...r, sourceKey, parentSourceKey, parentLabel, contentHash: hash }
  })
}
