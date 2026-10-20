import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequestLogger, generateRequestId, logger } from '../log';
import { createTrace, startSpan, endSpan, finishTrace, withSpan, getTraceMetrics } from '../observability/trace';
import { recordPipelineMetrics, getDashboardMetrics, getPerformanceTrends, getSystemHealth, exportPrometheusMetrics } from '../observability/metrics';
import { executeOrchestratorOpenAI as executeOrchestrator, ConversationMessage, OrchestratorContext } from '../orchestrator/stylist-openai';
import { getPoolStats } from '../db';

// Request validation schema
const ChatRequestSchema = z.object({
  userQuery: z.string().min(1, 'User query is required'),
  topK: z.number().int().min(1).max(50).default(12),
  pageContext: z.object({
    productId: z.string().optional(),
  }).optional(),
  imageUrl: z.string().optional(), // Allow both URLs and base64 data URLs
  conversationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    timestamp: z.coerce.date().optional(), // Coerce string to Date (from JSON serialization)
  })).optional().default([]),
  userLocation: z.string().optional(), // Country code for SerpAPI
  excludeProductIds: z.array(z.string()).optional(), // For "show more" functionality
});

type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatResponse {
  type: 'search_results' | 'follow_up_question' | 'chat_response' | 'fashion_advice';
  results?: Array<{
    product_id: number | string; // Can be number (database) or string (SerpAPI)
    title: string;
    brand?: string;
    image_url?: string;
    category?: string;
    similarity_score?: number;
    _source?: 'serpapi' | 'database'; // Metadata to distinguish source
    best_offer: {
      retailer: string;
      retailer_domain: string;
      price: number;
      currency: string;
      original_price?: number;
      url: string;
      affiliate_url?: string;
      in_stock: boolean;
      condition: string;
    };
  }>;
  message?: string; // For follow-up questions or chat responses
  advice?: string; // For fashion advice responses
  suggestions?: Array<{ item: string; reasoning: string }>; // Fashion suggestions with reasoning
  followUpPrompt?: string; // Optional follow-up prompt after fashion advice
  parsed?: {
    freeText: string;
    filters: Record<string, any>;
    limit: number;
  };
  facets?: null;
  relaxedSteps?: string[];
  relaxationMessage?: string;
  traceId: string;
  finalImageEmbedding?: number[] | null; // Returned for SerpAPI search if needed
  searchKeywords?: string; // Keywords for SerpAPI search
  parsedQuery?: string; // Parsed query text
  searchFilters?: Record<string, any>; // Filters for SerpAPI
}

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ChatRequest }>('/chat', {
    handler: async (
      request: FastifyRequest<{ Body: any }>, 
      reply: FastifyReply
    ) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();

      // Create trace context before starting spans
      createTrace(requestId);

      const requestBody = request.body as any;
      const rootSpan = startSpan(requestId, 'rag_pipeline', {
        userQuery: requestBody?.userQuery,
        topK: requestBody?.topK,
        hasImageUrl: !!requestBody?.imageUrl,
        hasPageContext: !!requestBody?.pageContext
      });

      try {
        // Validate request body
        const validationResult = ChatRequestSchema.safeParse(request.body);
        if (!validationResult.success) {
          endSpan(requestId, rootSpan.id, undefined, undefined, 'Validation failed');
          await finishTrace(requestId);
          
          return reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors,
            traceId: requestId,
          });
        }

        const { userQuery, topK, pageContext, imageUrl, conversationHistory = [], userLocation, excludeProductIds } = validationResult.data;

        // Prepare orchestrator context
        const orchestratorContext: OrchestratorContext = {
          pageContext,
          imageUrl,
          userLocation,
          topK,
          excludeProductIds,
        };

        // Convert conversation history to the format expected by orchestrator
        const formattedHistory: ConversationMessage[] = conversationHistory.map(msg => ({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
        }));

        // Check for selected product in page context (could be from SerpAPI)
        let selectedProductId = pageContext?.productId;

        // Execute orchestrator
        const orchestratorResult = await withSpan(requestId, 'orchestrator_execution', async (spanId) => {
          return executeOrchestrator(
            userQuery,
            formattedHistory,
            orchestratorContext,
            requestLogger,
            requestId,
            selectedProductId // Pass selected product ID if available
          );
        }, {
          userQuery,
          historyLength: formattedHistory.length,
          hasPageContext: !!pageContext,
          hasImageUrl: !!imageUrl,
          hasSelectedProduct: !!selectedProductId,
        }, rootSpan.id);

        const duration = Date.now() - startTime;
        
        // Handle different response types
        let response: ChatResponse;

        if (orchestratorResult.result.type === 'follow_up_question') {
          // Return follow-up question
          response = {
            type: 'follow_up_question',
            message: orchestratorResult.result.question,
            traceId: requestId,
          };
        } else if (orchestratorResult.result.type === 'chat_response') {
          // Return chat response
          response = {
            type: 'chat_response',
            message: orchestratorResult.result.message,
            traceId: requestId,
          };
        } else if (orchestratorResult.result.type === 'fashion_advice') {
          // Return fashion advice with suggestions
          response = {
            type: 'fashion_advice',
            advice: orchestratorResult.result.advice,
            suggestions: orchestratorResult.result.suggestions,
            followUpPrompt: orchestratorResult.result.followUpPrompt,
            traceId: requestId,
          };
        } else if (orchestratorResult.result.type === 'search_results') {
          // Handle search results
          const searchResults = orchestratorResult.result.results || [];
          
          // Use the message from the orchestrator (LLM generates it now)
          const contextualMessage = orchestratorResult.result.message || 
            (searchResults.length > 0 
              ? `I found ${searchResults.length} great ${searchResults.length === 1 ? 'option' : 'options'} for you!`
              : "I couldn't find any products matching your request. Try adjusting your search terms or being more specific about what you're looking for.");
          
          // If we have results, enrich them with facets and explanations
          if (searchResults.length > 0) {
            // Generate facets from candidate IDs
            const candidateIds = searchResults.map((r: any) => r.product_id);
            
            // Use metadata from orchestrator (no need for separate parseIntent call)
            response = {
              type: 'search_results',
              results: searchResults,
              message: contextualMessage, // Include contextual message
              parsed: {
                freeText: userQuery,
                filters: orchestratorResult.result.filters || {},
                limit: orchestratorResult.result.limit || 10,
              },
              facets: null,
              traceId: requestId,
              finalImageEmbedding: orchestratorResult.result.finalImageEmbedding || null,
              searchKeywords: orchestratorResult.result.searchKeywords, // Keywords for SerpAPI
              parsedQuery: orchestratorResult.result.parsedQuery, // Parsed query text
              searchFilters: orchestratorResult.result.filters, // Filters for SerpAPI
            };
          } else {
            // No results found - still include keywords for SerpAPI fallback
            response = {
              type: 'search_results',
              results: [],
              message: contextualMessage, // Include contextual message
              parsed: {
                freeText: userQuery,
                filters: orchestratorResult.result.filters || {},
                limit: orchestratorResult.result.limit || 10,
              },
              traceId: requestId,
              finalImageEmbedding: orchestratorResult.result.finalImageEmbedding || null,
              searchKeywords: orchestratorResult.result.searchKeywords,
              parsedQuery: orchestratorResult.result.parsedQuery,
              searchFilters: orchestratorResult.result.filters,
            };
          }
        } else {
          // Error case
          response = {
            type: 'chat_response',
            message: orchestratorResult.result.error || "I'm sorry, I encountered an error while searching.",
            traceId: requestId,
          };
        }

        // End root span with final metrics
        const finalMetrics = getTraceMetrics(requestId);
        endSpan(requestId, rootSpan.id, {
          responseType: response.type,
          resultsCount: response.results?.length || 0,
          metrics: finalMetrics
        }, {
          totalDuration: duration
        });

        // Record metrics for dashboard
        if (finalMetrics) {
          recordPipelineMetrics(requestId, finalMetrics, true);
        }

        // Finish trace and send to LangSmith
        await finishTrace(requestId);

        return reply.code(200).send(response);

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Record error in trace
        endSpan(requestId, rootSpan.id, undefined, {
          errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
          duration
        }, errorMessage);

        // Record error metrics
        const errorMetrics = getTraceMetrics(requestId);
        if (errorMetrics) {
          recordPipelineMetrics(requestId, errorMetrics, false, errorMessage);
        }

        // Finish trace even on error
        await finishTrace(requestId);

        return reply.code(500).send({
          error: 'Internal server error',
          traceId: requestId,
        });
      }
    },
  });

  // Dashboard metrics endpoint
  fastify.get('/metrics/dashboard', {
    handler: async (request, reply) => {
      try {
        const { startTime, endTime, environment } = request.query as any;
        
        const start = startTime ? new Date(startTime) : undefined;
        const end = endTime ? new Date(endTime) : undefined;
        const env = environment as 'staging' | 'production' | undefined;
        
        const metrics = getDashboardMetrics(start, end, env);
        const trends = getPerformanceTrends(24);
        const health = getSystemHealth();
        
        return reply.code(200).send({
          metrics,
          trends,
          health,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Dashboard metrics request failed');
        
        return reply.code(500).send({
          error: 'Failed to retrieve metrics'
        });
      }
    }
  });

  // Prometheus metrics endpoint
  fastify.get('/metrics/prometheus', {
    handler: async (request, reply) => {
      try {
        const prometheusMetrics = exportPrometheusMetrics();
        
        return reply
          .code(200)
          .header('Content-Type', 'text/plain')
          .send(prometheusMetrics);
          
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Prometheus metrics request failed');
        
        return reply.code(500).send('# Error retrieving metrics\n');
      }
    }
  });

  // Health check endpoint
  fastify.get('/health', {
    handler: async (request, reply) => {
      try {
        const health = getSystemHealth();
        const poolStats = getPoolStats();
        const statusCode = health.status === 'healthy' ? 200 : 
                          health.status === 'degraded' ? 200 : 503;
        
        return reply.code(statusCode).send({
          status: health.status,
          issues: health.issues,
          metrics: health.metrics,
          database: {
            readPool: poolStats.read,
            writePool: poolStats.write,
          },
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        return reply.code(503).send({
          status: 'critical',
          issues: ['Health check failed'],
          timestamp: new Date().toISOString()
        });
      }
    }
  });
}
