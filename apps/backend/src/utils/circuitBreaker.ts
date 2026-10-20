import { logger } from '../log';

/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures by "opening" the circuit after too many failures,
 * allowing the downstream service time to recover before trying again.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests fail immediately without calling the service
 * - HALF_OPEN: Testing if service has recovered, allows limited requests through
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Name for logging purposes */
  name: string;
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of successes in half-open state to close the circuit (default: 2) */
  successThreshold?: number;
  /** Time in ms to wait before transitioning from open to half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Time window in ms to count failures (default: 60000) */
  failureWindowMs?: number;
  /** Optional callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreakerError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly state: CircuitState
  ) {
    super(`Circuit breaker '${circuitName}' is ${state.toUpperCase()} - service unavailable`);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = []; // Timestamps of recent failures
  private successCount = 0;
  private lastFailureTime = 0;
  private lastStateChange = Date.now();

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly failureWindowMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.failureWindowMs = options.failureWindowMs ?? 60000;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Execute a function through the circuit breaker
   * @throws CircuitBreakerError if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check and possibly transition state
    this.checkStateTransition();

    if (this.state === 'open') {
      logger.warn({
        circuit: this.name,
        state: this.state,
        timeSinceOpen: Date.now() - this.lastStateChange,
        resetTimeoutMs: this.resetTimeoutMs,
      }, '🔴 Circuit breaker OPEN - rejecting request');
      
      throw new CircuitBreakerError(this.name, this.state);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Check if we should transition states based on time
   */
  private checkStateTransition(): void {
    if (this.state === 'open') {
      const timeSinceOpen = Date.now() - this.lastStateChange;
      if (timeSinceOpen >= this.resetTimeoutMs) {
        this.transitionTo('half_open');
      }
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      
      logger.debug({
        circuit: this.name,
        successCount: this.successCount,
        successThreshold: this.successThreshold,
      }, '✅ Circuit breaker success in half-open state');

      if (this.successCount >= this.successThreshold) {
        this.transitionTo('closed');
      }
    } else if (this.state === 'closed') {
      // Clean up old failures outside the window
      this.pruneOldFailures();
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;

    if (this.state === 'half_open') {
      // Any failure in half-open state reopens the circuit
      logger.warn({
        circuit: this.name,
      }, '⚠️ Failure in half-open state - reopening circuit');
      this.transitionTo('open');
    } else if (this.state === 'closed') {
      // Record failure and check threshold
      this.failures.push(now);
      this.pruneOldFailures();

      logger.debug({
        circuit: this.name,
        recentFailures: this.failures.length,
        failureThreshold: this.failureThreshold,
      }, '⚠️ Circuit breaker recorded failure');

      if (this.failures.length >= this.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  /**
   * Remove failures outside the time window
   */
  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.failureWindowMs;
    this.failures = this.failures.filter(timestamp => timestamp > cutoff);
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const previousState = this.state;
    
    if (previousState === newState) return;

    this.state = newState;
    this.lastStateChange = Date.now();

    // Reset counters on state change
    if (newState === 'closed') {
      this.failures = [];
      this.successCount = 0;
    } else if (newState === 'half_open') {
      this.successCount = 0;
    }

    logger.info({
      circuit: this.name,
      from: previousState,
      to: newState,
      recentFailures: this.failures.length,
    }, `🔄 Circuit breaker state transition: ${previousState.toUpperCase()} → ${newState.toUpperCase()}`);

    this.onStateChange?.(previousState, newState);
  }

  /**
   * Get current circuit breaker status
   */
  getStatus(): {
    name: string;
    state: CircuitState;
    failures: number;
    lastFailureTime: number;
    lastStateChange: number;
    timeSinceStateChange: number;
    config: {
      failureThreshold: number;
      successThreshold: number;
      resetTimeoutMs: number;
      failureWindowMs: number;
    };
  } {
    this.pruneOldFailures();
    
    return {
      name: this.name,
      state: this.state,
      failures: this.failures.length,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      timeSinceStateChange: Date.now() - this.lastStateChange,
      config: {
        failureThreshold: this.failureThreshold,
        successThreshold: this.successThreshold,
        resetTimeoutMs: this.resetTimeoutMs,
        failureWindowMs: this.failureWindowMs,
      },
    };
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    this.transitionTo('closed');
    logger.info({ circuit: this.name }, '🔧 Circuit breaker manually reset');
  }

  /**
   * Check if circuit is allowing requests
   */
  isAllowingRequests(): boolean {
    this.checkStateTransition();
    return this.state !== 'open';
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }
}

// ==================== Pre-configured Circuit Breakers ====================

/**
 * Circuit breaker for text embedding service (Gemini API)
 */
export const textEmbeddingCircuit = new CircuitBreaker({
  name: 'text-embedding',
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30000, // 30 seconds
  failureWindowMs: 60000, // 1 minute
  onStateChange: (from, to) => {
    if (to === 'open') {
      logger.error({
        service: 'text-embedding',
        transition: `${from} → ${to}`,
      }, '🚨 TEXT EMBEDDING CIRCUIT OPENED - Service degraded');
    }
  },
});

/**
 * Circuit breaker for image embedding service (SigLIP)
 */
export const imageEmbeddingCircuit = new CircuitBreaker({
  name: 'image-embedding',
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30000, // 30 seconds
  failureWindowMs: 60000, // 1 minute
  onStateChange: (from, to) => {
    if (to === 'open') {
      logger.error({
        service: 'image-embedding',
        transition: `${from} → ${to}`,
      }, '🚨 IMAGE EMBEDDING CIRCUIT OPENED - Service degraded');
    }
  },
});

/**
 * Get status of all circuit breakers
 */
export function getAllCircuitBreakerStatus() {
  return {
    textEmbedding: textEmbeddingCircuit.getStatus(),
    imageEmbedding: imageEmbeddingCircuit.getStatus(),
  };
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers() {
  textEmbeddingCircuit.reset();
  imageEmbeddingCircuit.reset();
}

