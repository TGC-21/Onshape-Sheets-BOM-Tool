export const normalize = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
