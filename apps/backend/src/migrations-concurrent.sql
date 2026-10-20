-- ============================================
-- CONCURRENT INDEX CREATION
-- Run these separately outside of transactions for production safety
-- ============================================

-- Normalized column indexes (case-insensitive filters)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_brand_norm ON products(brand_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category_norm ON products(category_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_sub_category_norm ON products(sub_category_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_color_norm ON products(color_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_primary_material_norm ON products(primary_material_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_gender_norm ON products(gender_norm);

-- JSONB attribute index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_attributes_color ON products ((attributes->>'color'));

-- HNSW vector indexes (higher performance than IVFFlat)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_embedding_text_semantic_hnsw ON products USING hnsw (embedding_text_semantic vector_cosine_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_embed_image_hnsw ON products USING hnsw (embedding_image vector_cosine_ops);

-- Additional offer indexes for common query patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_product_price ON offers(product_id, price);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_country ON offers(country);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_price_in_stock ON offers(price, in_stock);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_condition ON offers(condition);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_product_in_stock ON offers(product_id, in_stock);

-- Optional: GIN index for general JSONB queries (uncomment if needed)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_attributes_gin ON products USING GIN (attributes);
