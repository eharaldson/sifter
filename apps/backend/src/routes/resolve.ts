import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveProduct } from '../match/resolve';
import { normalizeExtracted, extractDomain } from '../match/normalize';
import { createRequestLogger, generateRequestId } from '../log';
import { getQueueStats, getEmbeddingQueueForDebug } from '../jobs/queue';

// Request validation schema
const ResolveRequestSchema = z.object({
  retailer_domain: z.string().min(1),
  page_url: z.string().url(),
  extracted: z.object({
    title: z.string().min(1),
    brand: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    price: z.number().positive(),
    currency: z.string().length(3),
    originalPrice: z.number().positive().nullable().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).optional(),
    images: z.array(z.string().url()).optional(),
    color: z.string().nullable().optional(),
    primaryMaterial: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    subCategory: z.string().nullable().optional(),
    gtin: z.string().nullable().optional(),
    mpn: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
  }),
  // Source indicator for prioritization (extension requests get sync embeddings)
  source: z.enum(['extension', 'scraper', 'api']).optional().default('api'),
  // Whether to wait for embeddings before responding
  sync_embeddings: z.boolean().optional(),
});

type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

// Backpressure: reject when too many /resolve are running concurrently.
// This protects liveness/health checks during large scrape bursts.
const MAX_INFLIGHT_RESOLVES = parseInt(process.env.MAX_INFLIGHT_RESOLVES || '30');
let inflightResolves = 0;

export async function resolveRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ResolveRequest }>('/resolve', {
    handler: async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();
      
      // Timing tracker for the route handler
      const routeTimings: Record<string, number> = {};
      const markTiming = (step: string, stepStartTime: number) => {
        routeTimings[step] = Date.now() - stepStartTime;
      };

      // Avoid JSON.stringify on potentially large payloads (can block event loop under load)
      requestLogger.info({
        contentLength: request.headers['content-length'],
      }, '📥 ROUTE: /resolve request received');

      try {
        // Apply backpressure before doing any heavy work
        if (Number.isFinite(MAX_INFLIGHT_RESOLVES) && MAX_INFLIGHT_RESOLVES > 0 && inflightResolves >= MAX_INFLIGHT_RESOLVES) {
          requestLogger.warn(
            { inflightResolves, maxInflight: MAX_INFLIGHT_RESOLVES },
            '🚦 Backpressure: rejecting /resolve due to high concurrency'
          );
          return reply
            .code(429)
            .header('Retry-After', '5')
            .send({
              error: 'Server busy',
              message: 'Too many concurrent resolve requests. Please retry shortly.',
              request_id: requestId,
            });
        }

        inflightResolves++;

        // Validate request body manually
        const validationStartTime = Date.now();
        var validationResult = ResolveRequestSchema.safeParse(request.body);

        if (validationResult.data?.page_url) {
          validationResult.data.page_url = validationResult.data.page_url.split('?')[0];
        }
        markTiming('validation', validationStartTime);
        
        if (!validationResult.success) {
          requestLogger.warn({
            errors: validationResult.error.errors,
            routeTimings,
          }, '⚠️ ROUTE: Validation failed');
          return reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors,
            request_id: requestId,
          });
        }

        const { retailer_domain, page_url, extracted, source, sync_embeddings } = validationResult.data;

        // Determine if we should generate embeddings synchronously
        // Extension requests get sync embeddings by default (needed for immediate search)
        // Scrapers get async embeddings by default (better throughput)
        const shouldSyncEmbeddings = sync_embeddings ?? (source === 'extension');

        requestLogger.info({
          source,
          sync_embeddings: shouldSyncEmbeddings,
          retailer_domain,
          page_url,
          title: extracted.title?.substring(0, 50),
          brand: extracted.brand,
          price: extracted.price,
          validationMs: routeTimings.validation,
        }, '📋 ROUTE: Request validated - starting resolve');

        // Normalize the extracted data
        const normalizeStartTime = Date.now();
        const normalized = normalizeExtracted(extracted);
        markTiming('normalize', normalizeStartTime);
        
        // Ensure retailer_domain is properly formatted
        const domain = extractDomain(retailer_domain);

        // Resolve the product, passing the sync preference
        const resolveStartTime = Date.now();
        const result = await resolveProduct(domain, page_url, normalized, undefined, shouldSyncEmbeddings);
        markTiming('resolveProduct', resolveStartTime);

        const totalDuration = Date.now() - startTime;
        requestLogger.info({ 
          productId: result.product_id,
          offerId: result.offer_id,
          created: result.created,
          matchedVia: result.matched_via,
          totalDurationMs: totalDuration,
          routeTimings,
        }, `✅ ROUTE: /resolve complete in ${totalDuration}ms`);

        return reply.code(200).send(result);

      } catch (error) {
        const totalDuration = Date.now() - startTime;
        requestLogger.error({ 
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : 'Unknown',
          stack: error instanceof Error ? error.stack?.substring(0, 500) : undefined,
          totalDurationMs: totalDuration,
          routeTimings,
        }, `❌ ROUTE: /resolve failed after ${totalDuration}ms`);

        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
            request_id: requestId,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          request_id: requestId,
        });
      } finally {
        inflightResolves = Math.max(0, inflightResolves - 1);
      }
    },
  });

  // Debug route to inspect embedding queue health/state
  fastify.get('/resolve/debug/embedding-queue', {
    handler: async (_request, reply) => {
      try {
        const stats = await getQueueStats();
        let queueInfo: any = { available: false };
        try {
          const queue = await getEmbeddingQueueForDebug();
          if (queue) {
            const [failed, waiting, active, delayed] = await Promise.all([
              queue.getFailed(0, 5),
              queue.getWaiting(0, 5),
              queue.getActive(0, 5),
              queue.getDelayed(0, 5),
            ]);
            queueInfo = {
              available: true,
              failed: failed.map((j) => ({
                id: j.id,
                name: j.name,
                failedReason: j.failedReason,
                attemptsMade: j.attemptsMade,
                stacktrace: j.stacktrace,
                data: j.data,
              })),
              waiting: waiting.map((j) => ({ id: j.id, name: j.name, data: j.data })),
              active: active.map((j) => ({ id: j.id, name: j.name, data: j.data })),
              delayed: delayed.map((j) => ({ id: j.id, name: j.name, data: j.data })),
            };
          }
        } catch (err) {
          queueInfo = { available: false, error: err instanceof Error ? err.message : String(err) };
        }
        return reply.code(200).send({ stats, queueInfo });
      } catch (error) {
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
  });

  // Note: Health check endpoint is now in chat.ts for comprehensive system health
}
