import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../log';
import { 
  checkTextEmbeddingServiceHealth, 
  checkSigLipServiceHealth,
  isTextEmbeddingServiceReady,
  isSigLipServiceReady,
  getTextEmbeddingServiceInfo,
  getSigLipServiceInfo,
} from '../embeddings';
import { 
  getAllCircuitBreakerStatus, 
  resetAllCircuitBreakers,
  textEmbeddingCircuit,
  imageEmbeddingCircuit,
} from '../utils/circuitBreaker';
import { getQueueStats, isQueueHealthy } from '../jobs/queue';
import { query } from '../db';

/**
 * Diagnostics routes for monitoring and debugging the embedding services
 * and overall system health.
 */
export async function diagnosticsRoutes(fastify: FastifyInstance) {
  
  /**
   * Comprehensive health check for all embedding services
   * Returns detailed status of text and image embedding services
   */
  fastify.get('/diagnostics/embedding-health', async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    
    const results = {
      timestamp: new Date().toISOString(),
      overall_healthy: false,
      services: {
        textEmbedding: {
          healthy: false,
          cached_status: isTextEmbeddingServiceReady(),
          latency_ms: 0,
          error: null as string | null,
          circuit_breaker: textEmbeddingCircuit.getStatus(),
        },
        imageEmbedding: {
          healthy: false,
          cached_status: isSigLipServiceReady(),
          latency_ms: 0,
          error: null as string | null,
          circuit_breaker: imageEmbeddingCircuit.getStatus(),
        },
      },
      total_check_duration_ms: 0,
    };

    // Check text embedding service
    const textStart = Date.now();
    try {
      results.services.textEmbedding.healthy = await checkTextEmbeddingServiceHealth();
      results.services.textEmbedding.latency_ms = Date.now() - textStart;
    } catch (error) {
      results.services.textEmbedding.error = error instanceof Error ? error.message : String(error);
      results.services.textEmbedding.latency_ms = Date.now() - textStart;
    }

    // Check image embedding service
    const imageStart = Date.now();
    try {
      results.services.imageEmbedding.healthy = await checkSigLipServiceHealth();
      results.services.imageEmbedding.latency_ms = Date.now() - imageStart;
    } catch (error) {
      results.services.imageEmbedding.error = error instanceof Error ? error.message : String(error);
      results.services.imageEmbedding.latency_ms = Date.now() - imageStart;
    }

    results.overall_healthy = results.services.textEmbedding.healthy && results.services.imageEmbedding.healthy;
    results.total_check_duration_ms = Date.now() - startTime;

    const statusCode = results.overall_healthy ? 200 : 503;
    return reply.code(statusCode).send(results);
  });

  /**
   * Get detailed service information for embedding services
   */
  fastify.get('/diagnostics/embedding-info', async (request: FastifyRequest, reply: FastifyReply) => {
    const [textInfo, imageInfo] = await Promise.all([
      getTextEmbeddingServiceInfo(),
      getSigLipServiceInfo(),
    ]);

    return reply.send({
      timestamp: new Date().toISOString(),
      textEmbeddingService: textInfo,
      imageEmbeddingService: imageInfo,
    });
  });

  /**
   * Get circuit breaker status for all services
   */
  fastify.get('/diagnostics/circuit-breakers', async (request: FastifyRequest, reply: FastifyReply) => {
    const status = getAllCircuitBreakerStatus();
    
    return reply.send({
      timestamp: new Date().toISOString(),
      circuits: status,
      summary: {
        all_closed: status.textEmbedding.state === 'closed' && status.imageEmbedding.state === 'closed',
        any_open: status.textEmbedding.state === 'open' || status.imageEmbedding.state === 'open',
      },
    });
  });

  /**
   * Reset all circuit breakers (manual recovery)
   */
  fastify.post('/diagnostics/circuit-breakers/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    logger.info('🔧 Manual circuit breaker reset requested');
    
    resetAllCircuitBreakers();
    
    return reply.send({
      timestamp: new Date().toISOString(),
      status: 'reset_complete',
      circuits: getAllCircuitBreakerStatus(),
    });
  });

  /**
   * Get BullMQ queue statistics
   */
  fastify.get('/diagnostics/queue', async (request: FastifyRequest, reply: FastifyReply) => {
    const stats = await getQueueStats();
    const healthy = await isQueueHealthy();

    return reply.send({
      timestamp: new Date().toISOString(),
      redis_connected: healthy,
      queue: stats,
    });
  });

  /**
   * Get database connection pool statistics
   */
  fastify.get('/diagnostics/database', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Test query to verify connection
      const startTime = Date.now();
      await query('SELECT 1 as test');
      const queryLatency = Date.now() - startTime;

      // Get some basic stats
      const productCount = await query('SELECT COUNT(*) as count FROM products');
      const offerCount = await query('SELECT COUNT(*) as count FROM offers');
      const embeddingStats = await query(`
        SELECT 
          COUNT(*) as total_products,
          COUNT(embedding_text_semantic) as with_text_embedding,
          COUNT(embedding_image) as with_image_embedding,
          COUNT(CASE WHEN embedding_text_semantic IS NOT NULL AND embedding_image IS NOT NULL THEN 1 END) as with_both_embeddings
        FROM products
      `);

      return reply.send({
        timestamp: new Date().toISOString(),
        healthy: true,
        query_latency_ms: queryLatency,
        stats: {
          products: parseInt(productCount.rows[0].count),
          offers: parseInt(offerCount.rows[0].count),
          embeddings: {
            total_products: parseInt(embeddingStats.rows[0].total_products),
            with_text_embedding: parseInt(embeddingStats.rows[0].with_text_embedding),
            with_image_embedding: parseInt(embeddingStats.rows[0].with_image_embedding),
            with_both_embeddings: parseInt(embeddingStats.rows[0].with_both_embeddings),
            missing_text: parseInt(embeddingStats.rows[0].total_products) - parseInt(embeddingStats.rows[0].with_text_embedding),
            missing_image: parseInt(embeddingStats.rows[0].total_products) - parseInt(embeddingStats.rows[0].with_image_embedding),
          },
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Database diagnostics check failed');
      
      return reply.code(503).send({
        timestamp: new Date().toISOString(),
        healthy: false,
        error: errorMessage,
      });
    }
  });

  /**
   * Comprehensive system health check
   * Aggregates all service statuses into a single endpoint
   */
  fastify.get('/diagnostics/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    
    const checks = {
      database: { healthy: false, latency_ms: 0, error: null as string | null },
      textEmbedding: { healthy: false, latency_ms: 0, error: null as string | null },
      imageEmbedding: { healthy: false, latency_ms: 0, error: null as string | null },
      queue: { healthy: false, error: null as string | null },
    };

    // Database check
    const dbStart = Date.now();
    try {
      await query('SELECT 1');
      checks.database.healthy = true;
      checks.database.latency_ms = Date.now() - dbStart;
    } catch (error) {
      checks.database.error = error instanceof Error ? error.message : String(error);
      checks.database.latency_ms = Date.now() - dbStart;
    }

    // Text embedding check
    const textStart = Date.now();
    try {
      checks.textEmbedding.healthy = await checkTextEmbeddingServiceHealth();
      checks.textEmbedding.latency_ms = Date.now() - textStart;
    } catch (error) {
      checks.textEmbedding.error = error instanceof Error ? error.message : String(error);
      checks.textEmbedding.latency_ms = Date.now() - textStart;
    }

    // Image embedding check
    const imageStart = Date.now();
    try {
      checks.imageEmbedding.healthy = await checkSigLipServiceHealth();
      checks.imageEmbedding.latency_ms = Date.now() - imageStart;
    } catch (error) {
      checks.imageEmbedding.error = error instanceof Error ? error.message : String(error);
      checks.imageEmbedding.latency_ms = Date.now() - imageStart;
    }

    // Queue check
    try {
      checks.queue.healthy = await isQueueHealthy();
    } catch (error) {
      checks.queue.error = error instanceof Error ? error.message : String(error);
    }

    const overallHealthy = Object.values(checks).every(c => c.healthy);
    const criticalServicesHealthy = checks.database.healthy && 
      (checks.textEmbedding.healthy || textEmbeddingCircuit.getState() !== 'open') &&
      (checks.imageEmbedding.healthy || imageEmbeddingCircuit.getState() !== 'open');

    const result = {
      timestamp: new Date().toISOString(),
      status: overallHealthy ? 'healthy' : (criticalServicesHealthy ? 'degraded' : 'unhealthy'),
      overall_healthy: overallHealthy,
      critical_services_healthy: criticalServicesHealthy,
      checks,
      circuit_breakers: getAllCircuitBreakerStatus(),
      total_check_duration_ms: Date.now() - startTime,
    };

    const statusCode = overallHealthy ? 200 : (criticalServicesHealthy ? 200 : 503);
    return reply.code(statusCode).send(result);
  });

  /**
   * Test embedding generation (for debugging)
   * Generates a test embedding to verify the full pipeline works
   */
  fastify.post('/diagnostics/test-embedding', async (request: FastifyRequest<{ Body: { text?: string } }>, reply: FastifyReply) => {
    const { generateSemanticTextEmbedding, generateSigLipImageEmbedding, ProductData } = await import('../embeddings');
    const { withRetry } = await import('../utils/retry');
    
    const testText = request.body?.text || 'Test embedding for diagnostic purposes';
    const results = {
      timestamp: new Date().toISOString(),
      test_text: testText,
      text_embedding: {
        success: false,
        dimension: 0,
        latency_ms: 0,
        error: null as string | null,
        retries_used: 0,
      },
    };

    // Test text embedding with retry
    const textStart = Date.now();
    let textRetries = 0;
    try {
      const productData: ProductData = {
        id: 0,
        title: testText,
        search_text: testText,
      };
      
      const embedding = await withRetry(
        () => generateSemanticTextEmbedding(productData),
        { 
          maxRetries: 2, 
          baseDelayMs: 500,
          context: { operation: 'diagnostic-test' }
        }
      );
      
      results.text_embedding.success = true;
      results.text_embedding.dimension = embedding.length;
      results.text_embedding.latency_ms = Date.now() - textStart;
    } catch (error) {
      results.text_embedding.error = error instanceof Error ? error.message : String(error);
      results.text_embedding.latency_ms = Date.now() - textStart;
    }

    const statusCode = results.text_embedding.success ? 200 : 500;
    return reply.code(statusCode).send(results);
  });
}

