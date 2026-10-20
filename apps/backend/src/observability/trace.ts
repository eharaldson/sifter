import { logger } from '../log';
import { Client } from 'langsmith';
import { v4 as uuidv4 } from 'uuid';

// LangSmith configuration
const LANGSMITH_API_KEY = process.env.LANGCHAIN_API_KEY;
const LANGSMITH_PROJECT = process.env.LANGCHAIN_PROJECT || 'find-rag-pipeline';
const LANGSMITH_ENDPOINT = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';

// Initialize LangSmith client
let langsmithClient: Client | null = null;

if (LANGSMITH_API_KEY) {
  try {
    langsmithClient = new Client({
      apiKey: LANGSMITH_API_KEY,
      apiUrl: LANGSMITH_ENDPOINT,
    });
    logger.info({ project: LANGSMITH_PROJECT }, '🔍 LangSmith tracing initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize LangSmith client');
  }
} else {
  logger.warn('LangSmith API key not found, tracing will be local only');
}

// Types for tracing
export interface TraceSpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  inputs?: Record<string, any>;
  outputs?: Record<string, any>;
  metadata?: Record<string, any>;
  error?: string;
  parentId?: string;
  children: TraceSpan[];
}

export interface TraceContext {
  traceId: string;
  sessionId?: string;
  userId?: string;
  spans: Map<string, TraceSpan>;
  rootSpan?: TraceSpan;
}

export interface PipelineMetrics {
  // Timing metrics
  totalDuration: number;
  intentParseDuration: number;
  embeddingDuration: number;
  annDuration: number;
  ftsDuration: number;
  mergeDuration: number;
  rerankDuration: number;
  diversifyDuration: number;
  facetsDuration: number;
  
  // Count metrics
  annCandidateCount: number;
  ftsCandidateCount: number;
  mergedCandidateCount: number;
  finalResultCount: number;
  
  // Quality metrics
  intentConfidence: number;
  zeroResultRecovery: boolean;
  relaxationStepsApplied: number;
  
  // Performance metrics
  cacheHitRate: number;
  embeddingCacheHits: number;
  totalEmbeddingRequests: number;
}

// Global trace context storage
const activeTraces = new Map<string, TraceContext>();

/**
 * Create a new trace context
 */
export function createTrace(
  traceId?: string,
  sessionId?: string,
  userId?: string
): TraceContext {
  const id = traceId || uuidv4();
  
  const context: TraceContext = {
    traceId: id,
    sessionId,
    userId,
    spans: new Map(),
  };
  
  activeTraces.set(id, context);
  
  logger.debug({ traceId: id, sessionId, userId }, 'Created new trace context');
  
  return context;
}

/**
 * Get existing trace context
 */
export function getTrace(traceId: string): TraceContext | null {
  return activeTraces.get(traceId) || null;
}

/**
 * Start a new span within a trace
 */
export function startSpan(
  traceId: string,
  name: string,
  inputs?: Record<string, any>,
  parentSpanId?: string
): TraceSpan {
  const context = getTrace(traceId);
  if (!context) {
    throw new Error(`Trace context not found: ${traceId}`);
  }
  
  const span: TraceSpan = {
    id: uuidv4(),
    name,
    startTime: Date.now(),
    inputs: inputs ? sanitizeInputs(inputs) : undefined,
    parentId: parentSpanId,
    children: []
  };
  
  context.spans.set(span.id, span);
  
  // Add to parent's children if parent exists
  if (parentSpanId) {
    const parent = context.spans.get(parentSpanId);
    if (parent) {
      parent.children.push(span);
    }
  } else if (!context.rootSpan) {
    // This is the root span
    context.rootSpan = span;
  }
  
  logger.debug({
    traceId,
    spanId: span.id,
    spanName: name,
    parentSpanId
  }, 'Started span');
  
  return span;
}

/**
 * End a span and record outputs
 */
export function endSpan(
  traceId: string,
  spanId: string,
  outputs?: Record<string, any>,
  metadata?: Record<string, any>,
  error?: string
): void {
  const context = getTrace(traceId);
  if (!context) {
    logger.warn({ traceId, spanId }, 'Trace context not found when ending span');
    return;
  }
  
  const span = context.spans.get(spanId);
  if (!span) {
    logger.warn({ traceId, spanId }, 'Span not found when ending');
    return;
  }
  
  span.endTime = Date.now();
  span.duration = span.endTime - span.startTime;
  span.outputs = outputs ? sanitizeOutputs(outputs) : undefined;
  span.metadata = metadata;
  span.error = error;
  
  logger.debug({
    traceId,
    spanId,
    spanName: span.name,
    duration: span.duration,
    error: !!error
  }, 'Ended span');
  
  // Send to LangSmith if available
  if (langsmithClient && !error) {
    sendSpanToLangSmith(context, span).catch(err => {
      logger.warn({ error: err, spanId }, 'Failed to send span to LangSmith');
    });
  }
}

/**
 * Record an error in a span
 */
export function recordSpanError(
  traceId: string,
  spanId: string,
  error: Error | string
): void {
  const errorMessage = error instanceof Error ? error.message : error;
  const errorStack = error instanceof Error ? error.stack : undefined;
  
  endSpan(traceId, spanId, undefined, { errorStack }, errorMessage);
}

/**
 * Finish a trace and send to LangSmith
 */
export async function finishTrace(traceId: string): Promise<void> {
  const context = getTrace(traceId);
  if (!context) {
    logger.warn({ traceId }, 'Trace context not found when finishing');
    return;
  }
  
  // Calculate pipeline metrics
  const metrics = calculatePipelineMetrics(context);
  
  logger.info({
    traceId,
    metrics,
    spanCount: context.spans.size
  }, 'Trace completed');
  
  // Send complete trace to LangSmith
  if (langsmithClient && context.rootSpan) {
    try {
      await sendTraceToLangSmith(context);
    } catch (error) {
      logger.warn({ error, traceId }, 'Failed to send trace to LangSmith');
    }
  }
  
  // Clean up
  activeTraces.delete(traceId);
}

/**
 * Sanitize inputs for logging (remove sensitive data, limit size)
 */
function sanitizeInputs(inputs: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  
  Object.entries(inputs).forEach(([key, value]) => {
    if (key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
      sanitized[key] = '[REDACTED]';
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
      // Truncate large vectors
      sanitized[key] = value.length > 10 ? `[vector:${value.length}d]` : value;
    } else if (typeof value === 'string' && value.length > 1000) {
      sanitized[key] = value.substring(0, 1000) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  });
  
  return sanitized;
}

/**
 * Sanitize outputs for logging
 */
function sanitizeOutputs(outputs: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  
  Object.entries(outputs).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      // Limit array size in logs
      sanitized[key] = value.length > 100 ? `[array:${value.length} items]` : value;
    } else if (typeof value === 'object' && value !== null) {
      // Limit object complexity
      const keys = Object.keys(value);
      sanitized[key] = keys.length > 20 ? `[object:${keys.length} keys]` : value;
    } else {
      sanitized[key] = value;
    }
  });
  
  return sanitized;
}

/**
 * Calculate pipeline metrics from trace spans
 */
function calculatePipelineMetrics(context: TraceContext): PipelineMetrics {
  const spans = Array.from(context.spans.values());
  
  const getSpanDuration = (name: string): number => {
    const span = spans.find(s => s.name === name);
    return span?.duration || 0;
  };
  
  const getSpanOutput = (name: string, key: string): any => {
    const span = spans.find(s => s.name === name);
    return span?.outputs?.[key];
  };
  
  const rootSpan = context.rootSpan;
  const totalDuration = rootSpan?.duration || 0;
  
  return {
    // Timing metrics
    totalDuration,
    intentParseDuration: getSpanDuration('intent_parse'),
    embeddingDuration: getSpanDuration('embedding'),
    annDuration: getSpanDuration('ann_search'),
    ftsDuration: getSpanDuration('fts_search'),
    mergeDuration: getSpanDuration('merge_results'),
    rerankDuration: getSpanDuration('rerank'),
    diversifyDuration: getSpanDuration('diversify'),
    facetsDuration: getSpanDuration('compute_facets'),
    
    // Count metrics
    annCandidateCount: getSpanOutput('ann_search', 'candidateCount') || 0,
    ftsCandidateCount: getSpanOutput('fts_search', 'candidateCount') || 0,
    mergedCandidateCount: getSpanOutput('merge_results', 'mergedCount') || 0,
    finalResultCount: getSpanOutput('diversify', 'finalCount') || 0,
    
    // Quality metrics
    intentConfidence: getSpanOutput('intent_parse', 'confidence') || 0,
    zeroResultRecovery: !!getSpanOutput('zero_result_recovery', 'applied'),
    relaxationStepsApplied: getSpanOutput('zero_result_recovery', 'stepsApplied') || 0,
    
    // Performance metrics
    cacheHitRate: getSpanOutput('embedding', 'cacheHitRate') || 0,
    embeddingCacheHits: getSpanOutput('embedding', 'cacheHits') || 0,
    totalEmbeddingRequests: getSpanOutput('embedding', 'totalRequests') || 0,
  };
}

/**
 * Send individual span to LangSmith
 */
async function sendSpanToLangSmith(context: TraceContext, span: TraceSpan): Promise<void> {
  if (!langsmithClient) return;
  
  try {
    await langsmithClient.createRun({
      id: span.id,
      name: span.name,
      run_type: 'chain',
      inputs: span.inputs || {},
      outputs: span.outputs || {},
      start_time: span.startTime,
      end_time: span.endTime,
      extra: {
        metadata: {
          ...span.metadata,
          traceId: context.traceId,
          sessionId: context.sessionId,
          userId: context.userId,
          duration: span.duration
        }
      },
      trace_id: context.traceId,
      parent_run_id: span.parentId,
      project_name: LANGSMITH_PROJECT
    });
  } catch (error) {
    logger.debug({ error, spanId: span.id }, 'Failed to send span to LangSmith');
  }
}

/**
 * Send complete trace to LangSmith
 */
async function sendTraceToLangSmith(context: TraceContext): Promise<void> {
  if (!langsmithClient || !context.rootSpan) return;
  
  const metrics = calculatePipelineMetrics(context);
  
  try {
    // Send root span with complete metrics
    await langsmithClient.createRun({
      id: context.rootSpan.id,
      name: 'rag_pipeline',
      run_type: 'chain',
      inputs: context.rootSpan.inputs || {},
      outputs: {
        ...context.rootSpan.outputs,
        metrics
      },
      start_time: context.rootSpan.startTime,
      end_time: context.rootSpan.endTime,
      extra: {
        metadata: {
          traceId: context.traceId,
          sessionId: context.sessionId,
          userId: context.userId,
          spanCount: context.spans.size,
          ...metrics
        }
      },
      trace_id: context.traceId,
      project_name: LANGSMITH_PROJECT
    });
    
    logger.debug({ traceId: context.traceId }, 'Sent complete trace to LangSmith');
  } catch (error) {
    logger.warn({ error, traceId: context.traceId }, 'Failed to send trace to LangSmith');
  }
}

/**
 * Convenience function to wrap a function with tracing
 */
export function withSpan<T>(
  traceId: string,
  spanName: string,
  fn: (spanId: string) => Promise<T>,
  inputs?: Record<string, any>,
  parentSpanId?: string
): Promise<T> {
  const span = startSpan(traceId, spanName, inputs, parentSpanId);
  
  return fn(span.id)
    .then(result => {
      endSpan(traceId, span.id, { result });
      return result;
    })
    .catch(error => {
      recordSpanError(traceId, span.id, error);
      throw error;
    });
}

/**
 * Get trace metrics for dashboard/monitoring
 */
export function getTraceMetrics(traceId: string): PipelineMetrics | null {
  const context = getTrace(traceId);
  if (!context) return null;
  
  return calculatePipelineMetrics(context);
}

/**
 * Get active trace statistics
 */
export function getTracingStats(): {
  activeTraces: number;
  langsmithEnabled: boolean;
  project: string;
} {
  return {
    activeTraces: activeTraces.size,
    langsmithEnabled: !!langsmithClient,
    project: LANGSMITH_PROJECT
  };
}

/**
 * Clean up old traces (call periodically)
 */
export function cleanupOldTraces(maxAgeMs: number = 60 * 60 * 1000): void {
  const now = Date.now();
  const toDelete: string[] = [];
  
  activeTraces.forEach((context, traceId) => {
    const rootSpan = context.rootSpan;
    if (rootSpan && (now - rootSpan.startTime) > maxAgeMs) {
      toDelete.push(traceId);
    }
  });
  
  toDelete.forEach(traceId => {
    activeTraces.delete(traceId);
    logger.debug({ traceId }, 'Cleaned up old trace');
  });
  
  if (toDelete.length > 0) {
    logger.info({ cleanedUp: toDelete.length }, 'Cleaned up old traces');
  }
}

// Periodic cleanup
setInterval(() => {
  cleanupOldTraces();
}, 10 * 60 * 1000); // Every 10 minutes
