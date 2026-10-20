-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Retailers table
CREATE TABLE IF NOT EXISTS retailers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  country TEXT,
  supports_affiliate BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

-- Products table (canonical)
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  gtin TEXT,
  mpn TEXT,
  brand TEXT,
  title TEXT NOT NULL,
  description TEXT,
  title_clean TEXT,
  search_text TEXT,
  category TEXT,
  sub_category TEXT,
  color TEXT,
  primary_material TEXT,
  image_url TEXT,
  tsv TSVECTOR,
  embedding_text_semantic VECTOR(768), -- real text embedding that is used for everything
  embedding_image VECTOR(1152),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Indexes for products
CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_mpn ON products(mpn) WHERE mpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_tsv ON products USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_products_title_trgm ON products USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand) WHERE brand IS NOT NULL;
-- CREATE INDEX IF NOT EXISTS idx_products_embed_text ON products USING ivfflat (embedding_text vector_cosine_ops) WITH (lists=100);
-- CREATE INDEX IF NOT EXISTS idx_products_embed_text_semantic ON products USING ivfflat (embedding_text_semantic vector_cosine_ops) WITH (lists=100);
-- CREATE INDEX IF NOT EXISTS idx_products_embed_title ON products USING ivfflat (embedding_title vector_cosine_ops) WITH (lists=100);
-- CREATE INDEX IF NOT EXISTS idx_products_embed_image ON products USING ivfflat (embedding_image vector_cosine_ops) WITH (lists=100);

-- Offers table (retailer-specific)
CREATE TABLE IF NOT EXISTS offers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  retailer_id BIGINT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  affiliate_url TEXT,
  sku TEXT,
  condition TEXT CHECK (condition IN ('new','used','refurbished')) DEFAULT 'new',
  currency TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  price_usd NUMERIC(10,2) NOT NULL,
  original_price NUMERIC(10,2),
  in_stock BOOLEAN DEFAULT true,
  shipping_cost NUMERIC(10,2),
  shipping_badges TEXT[],
  country TEXT,
  last_seen_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (retailer_id, url)
);

-- Indexes for offers
CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_retailer ON offers(retailer_id);
CREATE INDEX IF NOT EXISTS idx_offers_price ON offers(price);
CREATE INDEX IF NOT EXISTS idx_offers_retailer_url ON offers(retailer_id, url);

-- Price history table
CREATE TABLE IF NOT EXISTS offer_prices (
  offer_id BIGINT REFERENCES offers(id) ON DELETE CASCADE,
  captured_at TIMESTAMP NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  in_stock BOOLEAN,
  PRIMARY KEY (offer_id, captured_at)
);

-- Function to update tsvector automatically
CREATE OR REPLACE FUNCTION update_product_tsv() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('english', 
    COALESCE(NEW.title, '') || ' ' || 
    COALESCE(NEW.brand, '') || ' ' || 
    COALESCE(NEW.description, '') || ' ' ||
    COALESCE(NEW.color, '') || ' ' ||
    COALESCE(NEW.primary_material, '')
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update tsvector
DROP TRIGGER IF EXISTS trigger_update_product_tsv ON products;
CREATE TRIGGER trigger_update_product_tsv 
  BEFORE INSERT OR UPDATE ON products 
  FOR EACH ROW EXECUTE FUNCTION update_product_tsv();

-- ============================================
-- 1) Extensions (idempotent)
-- ============================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================
-- 2) Products: normalized columns for fast, reliable filtering
--    (keep originals for display; use *_norm for filters/joins)
-- ============================================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand_norm       TEXT GENERATED ALWAYS AS (lower(brand)) STORED,
  ADD COLUMN IF NOT EXISTS category_norm    TEXT GENERATED ALWAYS AS (lower(category)) STORED,
  ADD COLUMN IF NOT EXISTS sub_category_norm TEXT GENERATED ALWAYS AS (lower(sub_category)) STORED,
  ADD COLUMN IF NOT EXISTS color_norm       TEXT GENERATED ALWAYS AS (lower(color)) STORED,
  ADD COLUMN IF NOT EXISTS primary_material_norm    TEXT GENERATED ALWAYS AS (lower(primary_material)) STORED,
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS gender_norm TEXT GENERATED ALWAYS AS (lower(gender)) STORED;

-- Indexes for normalized columns (case-insensitive filters)
-- Note: CONCURRENTLY indexes should be created separately outside transactions
CREATE INDEX IF NOT EXISTS idx_products_brand_norm        ON products(brand_norm);
CREATE INDEX IF NOT EXISTS idx_products_category_norm     ON products(category_norm);
CREATE INDEX IF NOT EXISTS idx_products_sub_category_norm ON products(sub_category_norm);
CREATE INDEX IF NOT EXISTS idx_products_color_norm        ON products(color_norm);
CREATE INDEX IF NOT EXISTS idx_products_primary_material_norm     ON products(primary_material_norm);
CREATE INDEX IF NOT EXISTS idx_products_gender_norm       ON products(gender_norm);

-- ============================================
-- 3) Products: flexible attributes JSONB (for long-tail facets)
-- ============================================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS attributes JSONB;

-- Example GIN index if you plan to query arbitrary attributes often
-- (Optional: uncomment when needed)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_attributes_gin ON products USING GIN (attributes);

-- A focused index to facet/filter by color stored in JSONB (if you use attributes->>'color')
CREATE INDEX IF NOT EXISTS idx_products_attributes_color ON products ((attributes->>'color'));

-- ============================================
-- 4) Products: embedding hygiene + faster ANN index option
-- ============================================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding_text_semantic_updated_at TIMESTAMP;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding_image_updated_at TIMESTAMP;

-- New HNSW indexes (higher recall and speed vs IVFFlat). 
-- Keep IVFFlat for now; drop after verifying HNSW in staging.
-- Note: hnsw supports vector_cosine_ops with pgvector >= 0.5
-- Note: These should be created CONCURRENTLY in production, but not in transaction
-- CREATE INDEX IF NOT EXISTS idx_products_embed_text_hnsw 
--   ON products USING hnsw (embedding_text vector_cosine_ops);
-- 
-- CREATE INDEX IF NOT EXISTS idx_products_embed_text_semantic_hnsw 
--   ON products USING hnsw (embedding_text_semantic vector_cosine_ops);
-- 
-- CREATE INDEX IF NOT EXISTS idx_products_embed_title_hnsw 
--   ON products USING hnsw (embedding_title vector_cosine_ops);
-- 
-- CREATE INDEX IF NOT EXISTS idx_products_embed_image_hnsw 
--   ON products USING hnsw (embedding_image vector_cosine_ops);

-- ============================================
-- 5) Products: better-weighted tsvector for lexical relevance
--    (brand/title strong, description moderate, taxonomy light)
-- ============================================
CREATE OR REPLACE FUNCTION update_product_tsv() RETURNS trigger AS $$
BEGIN
  NEW.tsv := 
    setweight(to_tsvector('english', coalesce(NEW.brand, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(NEW.title, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.category, '')),    'C') ||
    setweight(to_tsvector('english', coalesce(NEW.sub_category, '')),'C') ||
    setweight(to_tsvector('simple',  coalesce(NEW.color, '')),       'D') ||
    setweight(to_tsvector('simple',  coalesce(NEW.primary_material, '')),    'D');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_product_tsv ON products;
CREATE TRIGGER trigger_update_product_tsv 
  BEFORE INSERT OR UPDATE ON products 
  FOR EACH ROW 
  EXECUTE FUNCTION update_product_tsv();

-- ============================================
-- 6) Offers: indexes for common filters + price ops
-- ============================================
CREATE INDEX IF NOT EXISTS idx_offers_product_price ON offers(product_id, price);
CREATE INDEX IF NOT EXISTS idx_offers_country        ON offers(country);

-- ============================================
-- 7) Current price snapshot per product
--    Materialized view denormalizes min/max price for fast range filters.
--    Populate/refresh via REFRESH MATERIALIZED VIEW CONCURRENTLY in jobs.
-- ============================================
DROP VIEW IF EXISTS product_search_v;
DROP MATERIALIZED VIEW IF EXISTS product_price_snapshot;
CREATE MATERIALIZED VIEW product_price_snapshot AS
SELECT 
  p.id AS product_id,
  MIN(o.price) FILTER (WHERE o.in_stock) AS min_price_in_stock,
  MAX(o.price) FILTER (WHERE o.in_stock) AS max_price_in_stock,
  MIN(o.price) AS min_price_any,
  MAX(o.price) AS max_price_any,
  COUNT(*) FILTER (WHERE o.in_stock) AS offers_in_stock
FROM products p
LEFT JOIN offers o ON o.product_id = p.id
GROUP BY p.id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pps_product ON product_price_snapshot(product_id);

-- To use: schedule "REFRESH MATERIALIZED VIEW CONCURRENTLY product_price_snapshot;" after offer ingests.

-- ============================================
-- 8) Additional indexes for common query patterns
-- ============================================

-- Composite index for price range queries with stock status
CREATE INDEX IF NOT EXISTS idx_offers_price_in_stock ON offers(price, in_stock);

-- Index for condition filtering (frequently used in ecommerce)
CREATE INDEX IF NOT EXISTS idx_offers_condition ON offers(condition);

-- Composite index for product + in_stock (common in search queries)
CREATE INDEX IF NOT EXISTS idx_offers_product_in_stock ON offers(product_id, in_stock);

-- ============================================
-- 9) Environment flag for vector index implementation
--    (for A/B testing IVFFlat vs HNSW performance)
-- ============================================

-- Create a simple config table for runtime flags
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT now()
);

-- Insert default vector index implementation flag
INSERT INTO system_config (key, value, description) VALUES 
  ('VECTOR_INDEX_IMPL', 'ivfflat', 'Vector index implementation: ivfflat or hnsw')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 10) Convenience view: product search projection
--     Keeps your search query clean and consistent.
-- ============================================
CREATE OR REPLACE VIEW product_search_v AS
SELECT
  p.id,
  p.title,
  p.description,
  p.brand, p.brand_norm,
  p.category, p.category_norm,
  p.sub_category, p.sub_category_norm,
  p.color, p.color_norm,
  p.primary_material, p.primary_material_norm,
  p.attributes,
  p.image_url,
  p.tsv,
  p.embedding_text_semantic,
  p.embedding_image,
  p.embedding_text_semantic_updated_at,
  p.embedding_image_updated_at,
  s.min_price_in_stock,
  s.max_price_in_stock,
  s.min_price_any,
  s.max_price_any,
  s.offers_in_stock
FROM products p
LEFT JOIN product_price_snapshot s ON s.product_id = p.id;

-- ============================================
-- 11) Helper function to refresh price snapshot
--     Call this after bulk offer updates
-- ============================================
CREATE OR REPLACE FUNCTION refresh_product_price_snapshot() 
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY product_price_snapshot;
  UPDATE system_config 
  SET value = extract(epoch from now())::text, updated_at = now()
  WHERE key = 'PRICE_SNAPSHOT_LAST_REFRESH';
END;
$$ LANGUAGE plpgsql;

-- Track when price snapshot was last refreshed
INSERT INTO system_config (key, value, description) VALUES 
  ('PRICE_SNAPSHOT_LAST_REFRESH', '0', 'Unix timestamp of last price snapshot refresh')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 12) Size Support - Standard Sizes Reference Table
--     Pre-populated with canonical sizes for US, UK, EU, JP
-- ============================================
CREATE TABLE IF NOT EXISTS standard_sizes (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('US', 'UK', 'EU', 'JP')),
  type TEXT NOT NULL CHECK (type IN ('alpha', 'numeric', 'shoe')),
  canonical_label TEXT NOT NULL,
  gender_group TEXT CHECK (gender_group IN ('male', 'female', 'unisex', 'kids')),
  category TEXT, -- 'tops', 'bottoms', 'footwear', 'outerwear', etc.
  sort_order INTEGER NOT NULL, -- For ordering sizes (XS=1, S=2, M=3, etc.)
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (region, type, canonical_label, gender_group, category)
);

-- Indexes for standard_sizes
CREATE INDEX IF NOT EXISTS idx_standard_sizes_lookup 
  ON standard_sizes(region, type, canonical_label, gender_group);
CREATE INDEX IF NOT EXISTS idx_standard_sizes_category 
  ON standard_sizes(category, type, region);

-- ============================================
-- 13) Size Support - Offer Variants Table
--     Links offers to specific sizes (handles multi-size and single-size)
-- ============================================
CREATE TABLE IF NOT EXISTS offer_variants (
  id BIGSERIAL PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  standard_size_id BIGINT REFERENCES standard_sizes(id) ON DELETE SET NULL,
  raw_size_label TEXT, -- Display value from retailer (e.g., "Large - Slim Fit", "UK 10")
  in_stock BOOLEAN DEFAULT true,
  sku TEXT, -- Variant-specific SKU if available
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Indexes for offer_variants
CREATE INDEX IF NOT EXISTS idx_offer_variants_offer 
  ON offer_variants(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_variants_standard_size 
  ON offer_variants(standard_size_id) WHERE standard_size_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_offer_variants_in_stock 
  ON offer_variants(offer_id, in_stock);

-- Composite index for size-based filtering
CREATE INDEX IF NOT EXISTS idx_offer_variants_size_stock 
  ON offer_variants(standard_size_id, in_stock) WHERE standard_size_id IS NOT NULL;
