ALTER TABLE catalog_parts ADD COLUMN IF NOT EXISTS original_part_number TEXT;
UPDATE catalog_parts SET original_part_number = canonical_part_number WHERE original_part_number IS NULL;
CREATE INDEX IF NOT EXISTS catalog_parts_canonical_idx ON catalog_parts (canonical_part_number);
CREATE INDEX IF NOT EXISTS part_aliases_alias_idx ON part_aliases (alias);
