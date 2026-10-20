import { enqueueEmbeddingJob, enqueueBatchEmbeddingJobs, JobPriority } from '../jobs/queue';
import { logger } from '../log';
import { query } from '../db';

// Fields that trigger embedding regeneration when updated
const EMBEDDING_TRIGGER_FIELDS = [
  'title',
  'brand', 
  'color',
  'material',
  'primary_material',  // Updated field name
  'category',
  'description',
  'image_url'
];

// Hook to enqueue embedding job after product creation
export async function onProductCreated(productId: number): Promise<void> {
  logger.info({ productId }, '🎯 onProductCreated hook called');
  
  try {
    const job = await enqueueEmbeddingJob(productId, 'both', JobPriority.NORMAL);
    if (job) {
      logger.info({ productId, jobId: job.id }, '✅ Embedding job enqueued successfully');
    } else {
      logger.warn({ productId }, '⚠️ enqueueEmbeddingJob returned null - job not enqueued');
    }
  } catch (error) {
    logger.error({
      productId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, '❌ Failed to enqueue embedding job for new product');
    
    // Don't throw - embedding generation failure shouldn't block product creation
  }
}

// Hook to enqueue embedding job after product update
export async function onProductUpdated(
  productId: number, 
  updatedFields: string[]
): Promise<void> {
  logger.info({ productId, updatedFields }, '🎯 onProductUpdated hook called');
  
  try {
    // First check if the product already has embeddings
    const result = await query(
      'SELECT embedding_text_semantic IS NOT NULL as has_text, embedding_image IS NOT NULL as has_image FROM products WHERE id = $1',
      [productId]
    );
    
    const hasEmbeddings = result.rows?.[0] || result[0];
    const missingEmbeddings = !hasEmbeddings?.has_text || !hasEmbeddings?.has_image;
    
    // Check if any updated fields require embedding regeneration
    const needsEmbeddingUpdate = updatedFields.some(field => 
      EMBEDDING_TRIGGER_FIELDS.includes(field)
    );

    // Generate embeddings if missing OR if relevant fields were updated
    if (!needsEmbeddingUpdate && !missingEmbeddings) {
      logger.debug({
        productId,
        updatedFields,
        hasText: hasEmbeddings?.has_text,
        hasImage: hasEmbeddings?.has_image,
      }, 'Product update does not require embedding regeneration');
      return;
    }
    // Determine which embeddings need to be regenerated
    let embeddingType: 'text' | 'image' | 'both' = 'both';
    
    if (missingEmbeddings) {
      // If embeddings are missing, generate what's missing
      if (!hasEmbeddings?.has_text && !hasEmbeddings?.has_image) {
        embeddingType = 'both';
      } else if (!hasEmbeddings?.has_text) {
        embeddingType = 'text';
      } else if (!hasEmbeddings?.has_image) {
        embeddingType = 'image';
      }
    } else {
      // If fields were updated, determine which embeddings to regenerate
      const textFields = ['title', 'brand', 'color', 'material', 'primary_material', 'category', 'description'];
      const imageFields = ['image_url'];
      
      const textFieldsUpdated = updatedFields.some(field => textFields.includes(field));
      const imageFieldsUpdated = updatedFields.some(field => imageFields.includes(field));
      
      if (textFieldsUpdated && !imageFieldsUpdated) {
        embeddingType = 'text';
      } else if (imageFieldsUpdated && !textFieldsUpdated) {
        embeddingType = 'image';
      }
    }

    logger.info({ productId, embeddingType }, '🎯 onProductUpdated - enqueuing embedding job');
    const job = await enqueueEmbeddingJob(productId, embeddingType, JobPriority.HIGH);
    if (job) {
      logger.info({ productId, jobId: job.id, embeddingType }, '✅ Embedding job enqueued successfully (update)');
    } else {
      logger.warn({ productId, embeddingType }, '⚠️ enqueueEmbeddingJob returned null - job not enqueued (update)');
    }
    
  } catch (error) {
    logger.error({
      productId,
      updatedFields,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, '❌ Failed to enqueue embedding job for updated product');
    
    // Don't throw - embedding generation failure shouldn't block product updates
  }
}

// Batch hook for multiple product creations (useful for data imports)
export async function onProductsBatchCreated(productIds: number[]): Promise<void> {
  try {
    await enqueueBatchEmbeddingJobs(productIds, 'both', JobPriority.LOW);
    
  } catch (error) {
    logger.error({
      productCount: productIds.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Failed to enqueue batch embedding jobs for new products');
  }
}

// Helper to extract updated fields from a database update operation
export function extractUpdatedFields(
  oldValues: Record<string, any>,
  newValues: Record<string, any>
): string[] {
  const updatedFields: string[] = [];
  
  for (const [key, newValue] of Object.entries(newValues)) {
    if (oldValues[key] !== newValue) {
      updatedFields.push(key);
    }
  }
  
  return updatedFields;
}

// Utility to check if a field change requires embedding update
export function requiresEmbeddingUpdate(updatedFields: string[]): boolean {
  return updatedFields.some(field => EMBEDDING_TRIGGER_FIELDS.includes(field));
}
