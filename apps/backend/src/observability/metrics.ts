import { logger } from '../log';
import { PipelineMetrics } from './trace';

// Types for dashboard metrics
export interface DashboardMetrics {
  // Performance metrics
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  avgDuration: number;
  
  // Step-specific performance
  stepMetrics: {
    intentParse: { p50: number; p95: number; avg: number };
    embedding: { p50: number; p95: number; avg: number };
    ann: { p50: number; p95: number; avg: number };
    fts: { p50: number; p95: number; avg: number };
    merge: { p50: number; p95: number; avg: number };
    rerank: { p50: number; p95: number; avg: number };
    diversify: { p50: number; p95: number; avg: number };
    facets: { p50: number; p95: number; avg: number };
  };
  
  // Quality metrics
  zeroResultRate: number;
  avgCandidateCount: number;
  avgFinalResultCount: number;
  relaxationRate: number;
  
  // Cache performance
  avgCacheHitRate: number;
  
  // Request volume
  totalRequests: number;
  successRate: number;
  errorRate: number;
  
  // Time period
  periodStart: Date;
  periodEnd: Date;
}

export interface MetricsSample {
  timestamp: Date;
  traceId: string;
  metrics: PipelineMetrics;
  success: boolean;
  error?: string;
}

// In-memory metrics storage (in production, use Redis/TimescaleDB)
class MetricsCollector {
  private samples: MetricsSample[] = [];
  private readonly maxSamples = 10000; // Keep last 10k samples
  
  /**
   * Record a pipeline execution
   */
  recordExecution(
    traceId: string,
    metrics: PipelineMetrics,
    success: boolean,
    error?: string
  ): void {
    const sample: MetricsSample = {
      timestamp: new Date(),
      traceId,
      metrics,
      success,
      error
    };
    
    this.samples.push(sample);
    
    // Keep only recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }
    
    logger.debug({
      traceId,
      success,
      totalDuration: metrics.totalDuration,
      finalResultCount: metrics.finalResultCount,
      zeroResultRecovery: metrics.zeroResultRecovery
    }, 'Recorded pipeline execution metrics');
  }
  
  /**
   * Calculate percentiles from array of values
   */
  private calculatePercentiles(values: number[]): { p50: number; p95: number; p99: number; avg: number } {
    if (values.length === 0) {
      return { p50: 0, p95: 0, p99: 0, avg: 0 };
    }
    
    const sorted = [...values].sort((a, b) => a - b);
    const len = sorted.length;
    
    return {
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
      avg: values.reduce((sum, val) => sum + val, 0) / len
    };
  }
  
  /**
   * Get dashboard metrics for a time period
   */
  getDashboardMetrics(
    startTime?: Date,
    endTime?: Date,
    environment?: 'staging' | 'production'
  ): DashboardMetrics {
    const now = new Date();
    const start = startTime || new Date(now.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours
    const end = endTime || now;
    
    // Filter samples by time period
    const filteredSamples = this.samples.filter(sample => 
      sample.timestamp >= start && sample.timestamp <= end
    );
    
    if (filteredSamples.length === 0) {
      return this.getEmptyMetrics(start, end);
    }
    
    // Extract metrics arrays
    const totalDurations = filteredSamples.map(s => s.metrics.totalDuration);
    const intentParseDurations = filteredSamples.map(s => s.metrics.intentParseDuration).filter(d => d > 0);
    const embeddingDurations = filteredSamples.map(s => s.metrics.embeddingDuration).filter(d => d > 0);
    const annDurations = filteredSamples.map(s => s.metrics.annDuration).filter(d => d > 0);
    const ftsDurations = filteredSamples.map(s => s.metrics.ftsDuration).filter(d => d > 0);
    const mergeDurations = filteredSamples.map(s => s.metrics.mergeDuration).filter(d => d > 0);
    const rerankDurations = filteredSamples.map(s => s.metrics.rerankDuration).filter(d => d > 0);
    const diversifyDurations = filteredSamples.map(s => s.metrics.diversifyDuration).filter(d => d > 0);
    const facetsDurations = filteredSamples.map(s => s.metrics.facetsDuration).filter(d => d > 0);
    
    // Calculate performance metrics
    const overallPerf = this.calculatePercentiles(totalDurations);
    
    // Calculate quality metrics
    const zeroResultCount = filteredSamples.filter(s => s.metrics.finalResultCount === 0).length;
    const relaxationCount = filteredSamples.filter(s => s.metrics.zeroResultRecovery).length;
    const successCount = filteredSamples.filter(s => s.success).length;
    
    const avgCandidateCount = filteredSamples.reduce((sum, s) => 
      sum + s.metrics.annCandidateCount + s.metrics.ftsCandidateCount, 0
    ) / filteredSamples.length;
    
    const avgFinalResultCount = filteredSamples.reduce((sum, s) => 
      sum + s.metrics.finalResultCount, 0
    ) / filteredSamples.length;
    
    const avgCacheHitRate = filteredSamples.reduce((sum, s) => 
      sum + s.metrics.cacheHitRate, 0
    ) / filteredSamples.length;
    
    return {
      // Performance metrics
      p50Duration: overallPerf.p50,
      p95Duration: overallPerf.p95,
      p99Duration: overallPerf.p99,
      avgDuration: overallPerf.avg,
      
      // Step-specific performance
      stepMetrics: {
        intentParse: this.calculatePercentiles(intentParseDurations),
        embedding: this.calculatePercentiles(embeddingDurations),
        ann: this.calculatePercentiles(annDurations),
        fts: this.calculatePercentiles(ftsDurations),
        merge: this.calculatePercentiles(mergeDurations),
        rerank: this.calculatePercentiles(rerankDurations),
        diversify: this.calculatePercentiles(diversifyDurations),
        facets: this.calculatePercentiles(facetsDurations)
      },
      
      // Quality metrics
      zeroResultRate: zeroResultCount / filteredSamples.length,
      avgCandidateCount,
      avgFinalResultCount,
      relaxationRate: relaxationCount / filteredSamples.length,
      
      // Cache performance
      avgCacheHitRate,
      
      // Request volume
      totalRequests: filteredSamples.length,
      successRate: successCount / filteredSamples.length,
      errorRate: (filteredSamples.length - successCount) / filteredSamples.length,
      
      // Time period
      periodStart: start,
      periodEnd: end
    };
  }
  
  /**
   * Get empty metrics structure
   */
  private getEmptyMetrics(start: Date, end: Date): DashboardMetrics {
    const emptyPerf = { p50: 0, p95: 0, p99: 0, avg: 0 };
    
    return {
      p50Duration: 0,
      p95Duration: 0,
      p99Duration: 0,
      avgDuration: 0,
      stepMetrics: {
        intentParse: emptyPerf,
        embedding: emptyPerf,
        ann: emptyPerf,
        fts: emptyPerf,
        merge: emptyPerf,
        rerank: emptyPerf,
        diversify: emptyPerf,
        facets: emptyPerf
      },
      zeroResultRate: 0,
      avgCandidateCount: 0,
      avgFinalResultCount: 0,
      relaxationRate: 0,
      avgCacheHitRate: 0,
      totalRequests: 0,
      successRate: 0,
      errorRate: 0,
      periodStart: start,
      periodEnd: end
    };
  }
  
  /**
   * Get recent performance trends
   */
  getPerformanceTrends(hours: number = 24): {
    hourly: Array<{
      hour: Date;
      avgDuration: number;
      requestCount: number;
      errorRate: number;
      zeroResultRate: number;
    }>;
    summary: {
      trend: 'improving' | 'degrading' | 'stable';
      changePercent: number;
    };
  } {
    const now = new Date();
    const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
    
    const filteredSamples = this.samples.filter(sample => 
      sample.timestamp >= startTime
    );
    
    // Group by hour
    const hourlyData = new Map<string, MetricsSample[]>();
    
    filteredSamples.forEach(sample => {
      const hour = new Date(sample.timestamp);
      hour.setMinutes(0, 0, 0);
      const hourKey = hour.toISOString();
      
      if (!hourlyData.has(hourKey)) {
        hourlyData.set(hourKey, []);
      }
      hourlyData.get(hourKey)!.push(sample);
    });
    
    // Calculate hourly metrics
    const hourly = Array.from(hourlyData.entries())
      .map(([hourKey, samples]) => {
        const hour = new Date(hourKey);
        const durations = samples.map(s => s.metrics.totalDuration);
        const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
        const errorCount = samples.filter(s => !s.success).length;
        const zeroResultCount = samples.filter(s => s.metrics.finalResultCount === 0).length;
        
        return {
          hour,
          avgDuration,
          requestCount: samples.length,
          errorRate: errorCount / samples.length,
          zeroResultRate: zeroResultCount / samples.length
        };
      })
      .sort((a, b) => a.hour.getTime() - b.hour.getTime());
    
    // Calculate trend
    let trend: 'improving' | 'degrading' | 'stable' = 'stable';
    let changePercent = 0;
    
    if (hourly.length >= 2) {
      const firstHalf = hourly.slice(0, Math.floor(hourly.length / 2));
      const secondHalf = hourly.slice(Math.floor(hourly.length / 2));
      
      const firstAvg = firstHalf.reduce((sum, h) => sum + h.avgDuration, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((sum, h) => sum + h.avgDuration, 0) / secondHalf.length;
      
      changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
      
      if (changePercent < -5) {
        trend = 'improving';
      } else if (changePercent > 5) {
        trend = 'degrading';
      }
    }
    
    return {
      hourly,
      summary: {
        trend,
        changePercent
      }
    };
  }
  
  /**
   * Get current system health
   */
  getSystemHealth(): {
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
    metrics: {
      recentP95: number;
      recentErrorRate: number;
      recentZeroResultRate: number;
    };
  } {
    const recentMetrics = this.getDashboardMetrics(
      new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
      new Date()
    );
    
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    
    // Check P95 latency
    if (recentMetrics.p95Duration > 2000) {
      issues.push(`High P95 latency: ${recentMetrics.p95Duration}ms`);
      status = 'critical';
    } else if (recentMetrics.p95Duration > 1000) {
      issues.push(`Elevated P95 latency: ${recentMetrics.p95Duration}ms`);
      status = 'degraded';
    }
    
    // Check error rate
    if (recentMetrics.errorRate > 0.05) {
      issues.push(`High error rate: ${(recentMetrics.errorRate * 100).toFixed(1)}%`);
      status = 'critical';
    } else if (recentMetrics.errorRate > 0.01) {
      issues.push(`Elevated error rate: ${(recentMetrics.errorRate * 100).toFixed(1)}%`);
      if (status === 'healthy') status = 'degraded';
    }
    
    // Check zero result rate
    if (recentMetrics.zeroResultRate > 0.2) {
      issues.push(`High zero result rate: ${(recentMetrics.zeroResultRate * 100).toFixed(1)}%`);
      if (status === 'healthy') status = 'degraded';
    }
    
    // Check cache hit rate
    if (recentMetrics.avgCacheHitRate < 0.5) {
      issues.push(`Low cache hit rate: ${(recentMetrics.avgCacheHitRate * 100).toFixed(1)}%`);
      if (status === 'healthy') status = 'degraded';
    }
    
    return {
      status,
      issues,
      metrics: {
        recentP95: recentMetrics.p95Duration,
        recentErrorRate: recentMetrics.errorRate,
        recentZeroResultRate: recentMetrics.zeroResultRate
      }
    };
  }
  
  /**
   * Clear old samples (for memory management)
   */
  clearOldSamples(olderThanHours: number = 48): number {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const originalLength = this.samples.length;
    
    this.samples = this.samples.filter(sample => sample.timestamp >= cutoff);
    
    const removed = originalLength - this.samples.length;
    if (removed > 0) {
      logger.info({ removed, remaining: this.samples.length }, 'Cleared old metric samples');
    }
    
    return removed;
  }
}

// Global metrics collector instance
export const metricsCollector = new MetricsCollector();

// Periodic cleanup
setInterval(() => {
  metricsCollector.clearOldSamples(48); // Keep 48 hours of data
}, 60 * 60 * 1000); // Run every hour

/**
 * Record pipeline execution metrics
 */
export function recordPipelineMetrics(
  traceId: string,
  metrics: PipelineMetrics,
  success: boolean,
  error?: string
): void {
  metricsCollector.recordExecution(traceId, metrics, success, error);
}

/**
 * Get dashboard metrics for monitoring
 */
export function getDashboardMetrics(
  startTime?: Date,
  endTime?: Date,
  environment?: 'staging' | 'production'
): DashboardMetrics {
  return metricsCollector.getDashboardMetrics(startTime, endTime, environment);
}

/**
 * Get performance trends
 */
export function getPerformanceTrends(hours: number = 24) {
  return metricsCollector.getPerformanceTrends(hours);
}

/**
 * Get system health status
 */
export function getSystemHealth() {
  return metricsCollector.getSystemHealth();
}

/**
 * Export metrics in Prometheus format (for external monitoring)
 */
export function exportPrometheusMetrics(): string {
  const metrics = metricsCollector.getDashboardMetrics();
  const health = metricsCollector.getSystemHealth();
  
  return `
# HELP rag_pipeline_duration_seconds RAG pipeline execution duration
# TYPE rag_pipeline_duration_seconds histogram
rag_pipeline_duration_p50 ${metrics.p50Duration / 1000}
rag_pipeline_duration_p95 ${metrics.p95Duration / 1000}
rag_pipeline_duration_p99 ${metrics.p99Duration / 1000}

# HELP rag_pipeline_requests_total Total number of RAG pipeline requests
# TYPE rag_pipeline_requests_total counter
rag_pipeline_requests_total ${metrics.totalRequests}

# HELP rag_pipeline_errors_total Total number of RAG pipeline errors
# TYPE rag_pipeline_errors_total counter
rag_pipeline_errors_total ${Math.round(metrics.totalRequests * metrics.errorRate)}

# HELP rag_pipeline_zero_results_total Total number of zero result queries
# TYPE rag_pipeline_zero_results_total counter
rag_pipeline_zero_results_total ${Math.round(metrics.totalRequests * metrics.zeroResultRate)}

# HELP rag_pipeline_cache_hit_rate Cache hit rate for embeddings
# TYPE rag_pipeline_cache_hit_rate gauge
rag_pipeline_cache_hit_rate ${metrics.avgCacheHitRate}

# HELP rag_pipeline_health System health status (0=critical, 1=degraded, 2=healthy)
# TYPE rag_pipeline_health gauge
rag_pipeline_health ${health.status === 'healthy' ? 2 : health.status === 'degraded' ? 1 : 0}
  `.trim();
}
