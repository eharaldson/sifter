#!/usr/bin/env python3
"""
Gemini Text Embedding Service
Provides text embeddings using Google's gemini-embedding-001 model.
Includes rate limiting to prevent API quota exhaustion.
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
import uvicorn
import logging
import time
import os
import asyncio
import numpy as np
import uuid
import json
import sys
import traceback
from typing import List, Optional
from contextlib import asynccontextmanager
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

# Configure structured JSON logging for production
class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_obj = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Add extra fields if present
        if hasattr(record, 'request_id'):
            log_obj['request_id'] = record.request_id
        if hasattr(record, 'extra_data'):
            log_obj.update(record.extra_data)
        if record.exc_info:
            log_obj['exception'] = self.formatException(record.exc_info)
        return json.dumps(log_obj)

# Configure logging - use JSON format for production, readable for development
LOG_FORMAT = os.getenv('LOG_FORMAT', 'json')  # 'json' or 'text'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s' if LOG_FORMAT == 'text' else None,
    handlers=[logging.StreamHandler(sys.stdout)]
)

if LOG_FORMAT == 'json':
    for handler in logging.root.handlers:
        handler.setFormatter(JSONFormatter())

logger = logging.getLogger(__name__)

def log_with_context(level: str, message: str, request_id: str = None, **extra):
    """Helper to log with structured context"""
    record = logging.LogRecord(
        name=logger.name,
        level=getattr(logging, level.upper()),
        pathname="",
        lineno=0,
        msg=message,
        args=(),
        exc_info=None
    )
    if request_id:
        record.request_id = request_id
    if extra:
        record.extra_data = extra
    logger.handle(record)

# Configuration
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
GEMINI_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSION = 768  # Configured dimension
MAX_BATCH_SIZE = 100  # Gemini batch limit is often lower or subject to rate limits, staying safe
MAX_INPUT_LENGTH = 2048  # Gemini embedding input token limit (approx)

# Rate limiting configuration (configurable via environment variables)
RATE_LIMIT_REQUESTS = int(os.getenv('RATE_LIMIT_REQUESTS', '15'))  # Requests per window
RATE_LIMIT_WINDOW_SECONDS = float(os.getenv('RATE_LIMIT_WINDOW_SECONDS', '1.0'))  # Time window
RATE_LIMIT_BURST_SIZE = int(os.getenv('RATE_LIMIT_BURST_SIZE', '5'))  # Allow burst above limit

# Global client
client = None


# ==================== Rate Limiter Implementation ====================

@dataclass
class RateLimiterStats:
    """Statistics for rate limiter monitoring"""
    total_requests: int = 0
    requests_allowed: int = 0
    requests_throttled: int = 0
    total_wait_time_ms: float = 0
    last_reset_time: datetime = field(default_factory=datetime.now)


class AsyncRateLimiter:
    """
    Async-safe sliding window rate limiter with burst support.
    
    Features:
    - Sliding window algorithm (smoother than fixed windows)
    - Configurable burst allowance
    - Wait-based throttling (requests wait instead of being rejected)
    - Statistics tracking for monitoring
    """
    
    def __init__(
        self, 
        max_requests: int = 15, 
        window_seconds: float = 1.0,
        burst_size: int = 5
    ):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.burst_size = burst_size
        self.requests: deque = deque()
        self.lock = asyncio.Lock()
        self.stats = RateLimiterStats()
        
        logger.info(
            f"📊 Rate limiter initialized: {max_requests} requests/{window_seconds}s, "
            f"burst: {burst_size}"
        )
    
    async def acquire(self) -> float:
        """
        Acquire a rate limit slot. Waits if necessary.
        Returns the wait time in seconds (0 if no wait was needed).
        """
        async with self.lock:
            self.stats.total_requests += 1
            now = time.time()
            
            # Remove requests outside the time window
            window_start = now - self.window_seconds
            while self.requests and self.requests[0] < window_start:
                self.requests.popleft()
            
            current_count = len(self.requests)
            effective_limit = self.max_requests + self.burst_size
            
            # If under limit, allow immediately
            if current_count < effective_limit:
                self.requests.append(now)
                self.stats.requests_allowed += 1
                return 0.0
            
            # Calculate wait time until oldest request expires
            oldest_request = self.requests[0]
            wait_time = (oldest_request + self.window_seconds) - now
            
            if wait_time > 0:
                self.stats.requests_throttled += 1
                self.stats.total_wait_time_ms += wait_time * 1000
                
                logger.warning(
                    f"⏳ Rate limit reached ({current_count}/{effective_limit}), "
                    f"waiting {wait_time:.3f}s"
                )
                
                # Release lock while waiting
                self.lock.release()
                try:
                    await asyncio.sleep(wait_time)
                finally:
                    await self.lock.acquire()
                
                # Re-check and add after waiting
                now = time.time()
                window_start = now - self.window_seconds
                while self.requests and self.requests[0] < window_start:
                    self.requests.popleft()
            
            self.requests.append(now)
            self.stats.requests_allowed += 1
            return wait_time if wait_time > 0 else 0.0
    
    def get_stats(self) -> dict:
        """Get rate limiter statistics"""
        return {
            "total_requests": self.stats.total_requests,
            "requests_allowed": self.stats.requests_allowed,
            "requests_throttled": self.stats.requests_throttled,
            "throttle_rate": (
                self.stats.requests_throttled / self.stats.total_requests * 100 
                if self.stats.total_requests > 0 else 0
            ),
            "avg_wait_time_ms": (
                self.stats.total_wait_time_ms / self.stats.requests_throttled 
                if self.stats.requests_throttled > 0 else 0
            ),
            "current_window_requests": len(self.requests),
            "config": {
                "max_requests": self.max_requests,
                "window_seconds": self.window_seconds,
                "burst_size": self.burst_size,
                "effective_limit": self.max_requests + self.burst_size,
            }
        }
    
    def reset_stats(self):
        """Reset statistics (useful for monitoring windows)"""
        self.stats = RateLimiterStats()


# Global rate limiter instance
rate_limiter = AsyncRateLimiter(
    max_requests=RATE_LIMIT_REQUESTS,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    burst_size=RATE_LIMIT_BURST_SIZE
)


# ==================== Metrics Tracking ====================

@dataclass  
class ServiceMetrics:
    """Service-level metrics for monitoring"""
    requests_total: int = 0
    requests_success: int = 0
    requests_failed: int = 0
    gemini_rate_limit_errors: int = 0
    gemini_other_errors: int = 0
    total_processing_time_ms: float = 0
    start_time: datetime = field(default_factory=datetime.now)


metrics = ServiceMetrics()


# ==================== FastAPI App ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Gemini client on startup and cleanup on shutdown"""
    global client
    
    log_with_context(
        "INFO",
        "🚀 Starting Gemini Text Embedding Service v2.1.0",
        service="text-embedding",
        log_format=LOG_FORMAT,
        log_level=LOG_LEVEL
    )
    
    try:
        if not GEMINI_API_KEY:
            log_with_context("ERROR", "❌ GEMINI_API_KEY environment variable is not set")
            raise ValueError("Gemini API key is required")
        
        log_with_context(
            "INFO",
            "🔧 Initializing Gemini client...",
            api_key_prefix=GEMINI_API_KEY[:8] + "..." if GEMINI_API_KEY else "none"
        )
        
        # Initialize Gemini client
        client = genai.Client(api_key=GEMINI_API_KEY)
        
        # Test the connection with a simple request
        log_with_context("INFO", "🧪 Testing Gemini connection...")
        
        test_start = time.time()
        test_response = client.models.embed_content(
            model=GEMINI_MODEL,
            contents="test",
            config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSION)
        )
        test_duration = time.time() - test_start
        
        if test_response.embeddings:
            actual_dim = len(test_response.embeddings[0].values)
            log_with_context(
                "INFO",
                "✅ Gemini connection successful",
                model=GEMINI_MODEL,
                embedding_dimension=actual_dim,
                test_duration_ms=round(test_duration * 1000, 2),
                rate_limit_requests=RATE_LIMIT_REQUESTS,
                rate_limit_window_seconds=RATE_LIMIT_WINDOW_SECONDS,
                rate_limit_burst_size=RATE_LIMIT_BURST_SIZE
            )
            
            if actual_dim != EMBEDDING_DIMENSION:
                log_with_context(
                    "WARNING",
                    f"⚠️ Dimension mismatch: expected {EMBEDDING_DIMENSION}, got {actual_dim}"
                )
            
            log_with_context(
                "INFO",
                "🟢 Service ready to process requests",
                host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", 8001))
            )
        else:
            raise ValueError("Invalid response from Gemini API")
        
        yield
        
    except Exception as e:
        log_with_context(
            "ERROR",
            f"💥 Failed to initialize Gemini service: {str(e)}",
            error_type=type(e).__name__,
            traceback=traceback.format_exc()
        )
        raise
    finally:
        log_with_context("INFO", "👋 Shutting down Gemini Text Embedding Service")


app = FastAPI(
    title="Gemini Text Embedding Service",
    description="High-performance text embeddings using Google's gemini-embedding-001 model with rate limiting",
    version="2.0.0",
    lifespan=lifespan
)


# ==================== Request Logging Middleware ====================

@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all incoming requests with timing and context"""
    request_id = str(uuid.uuid4())[:8]
    upstream_request_id = request.headers.get("x-request-id")
    start_time = time.time()
    
    # Store request_id in request state for use in endpoints
    request.state.request_id = request_id
    request.state.upstream_request_id = upstream_request_id
    
    # Log request arrival (don't read body here - it consumes the stream!)
    log_with_context(
        "INFO",
        f"📥 Request received: {request.method} {request.url.path}",
        request_id=request_id,
        upstream_request_id=upstream_request_id,
        method=request.method,
        path=str(request.url.path),
        query_params=str(request.query_params),
        client_host=request.client.host if request.client else "unknown",
        content_length=request.headers.get("content-length", "unknown")
    )
    
    try:
        response = await call_next(request)
        duration_ms = (time.time() - start_time) * 1000
        
        log_with_context(
            "INFO",
            f"📤 Request completed: {request.method} {request.url.path} -> {response.status_code}",
            request_id=request_id,
            upstream_request_id=upstream_request_id,
            method=request.method,
            path=str(request.url.path),
            status_code=response.status_code,
            duration_ms=round(duration_ms, 2)
        )
        
        return response
        
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        log_with_context(
            "ERROR",
            f"💥 Request failed: {request.method} {request.url.path} - {str(e)}",
            request_id=request_id,
            upstream_request_id=upstream_request_id,
            method=request.method,
            path=str(request.url.path),
            error=str(e),
            error_type=type(e).__name__,
            duration_ms=round(duration_ms, 2),
            traceback=traceback.format_exc()
        )
        raise


# ==================== Request/Response Models ====================

class TextInput(BaseModel):
    text: str = Field(..., description="Text to embed", max_length=MAX_INPUT_LENGTH * 4)

class BatchTextInput(BaseModel):
    texts: List[str] = Field(..., description="List of texts to embed", max_items=MAX_BATCH_SIZE)
    
    class Config:
        json_schema_extra = {
            "example": {
                "texts": ["Hello world", "Another text to embed"]
            }
        }

class HealthResponse(BaseModel):
    status: str
    model: str
    embedding_dimension: int
    max_batch_size: int
    max_input_length: int
    rate_limit: dict

class EmbeddingResponse(BaseModel):
    embedding: List[float]
    dimension: int
    model: str
    text: str
    processing_time: float
    rate_limit_wait_time: Optional[float] = None

class BatchEmbeddingResponse(BaseModel):
    embeddings: List[List[float]]
    dimension: int
    model: str
    count: int
    processing_time: float
    tokens_used: int
    rate_limit_wait_time: Optional[float] = None


# ==================== Helper Functions ====================

def l2_normalize_embedding(embedding: List[float]) -> List[float]:
    """Apply L2 normalization to embedding vector"""
    embedding_array = np.array(embedding, dtype=np.float32)
    norm = np.linalg.norm(embedding_array)
    
    if norm == 0:
        logger.warning("Zero-magnitude embedding detected, returning original")
        return embedding
    
    normalized = embedding_array / norm
    return normalized.tolist()


def truncate_text(text: str, max_chars: int = 8000) -> str:
    """Truncate text to fit within model limits"""
    if len(text) <= max_chars:
        return text
    
    truncated = text[:max_chars-3] + "..."
    logger.warning(f"Text truncated from {len(text)} to {len(truncated)} characters")
    return truncated


def is_rate_limit_error(error: Exception) -> bool:
    """Check if an error is a rate limit error from Gemini"""
    error_str = str(error).lower()
    return any(pattern in error_str for pattern in ['429', 'quota', 'rate limit', 'resource exhausted'])


# ==================== API Endpoints ====================

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint with rate limiter status"""
    return HealthResponse(
        status="healthy" if client is not None else "error",
        model=GEMINI_MODEL,
        embedding_dimension=EMBEDDING_DIMENSION,
        max_batch_size=MAX_BATCH_SIZE,
        max_input_length=MAX_INPUT_LENGTH,
        rate_limit=rate_limiter.get_stats()
    )


@app.post("/embed-text", response_model=EmbeddingResponse)
async def embed_text(input: TextInput, request: Request):
    """Generate embedding for a single text with rate limiting"""
    global metrics
    
    request_id = getattr(request.state, 'request_id', 'unknown')
    
    log_with_context(
        "INFO",
        "🔤 embed-text: Starting embedding generation",
        request_id=request_id,
        text_length=len(input.text),
        text_preview=input.text[:100] + "..." if len(input.text) > 100 else input.text
    )
    
    if client is None:
        log_with_context("ERROR", "❌ embed-text: Gemini client not initialized", request_id=request_id)
        raise HTTPException(status_code=503, detail="Gemini client not initialized")
    
    metrics.requests_total += 1
    start_time = time.time()
    
    try:
        # Apply rate limiting (waits if necessary)
        rate_limit_start = time.time()
        log_with_context("INFO", "⏳ embed-text: Acquiring rate limit slot...", request_id=request_id)
        wait_time = await rate_limiter.acquire()
        rate_limit_duration = time.time() - rate_limit_start
        
        log_with_context(
            "INFO",
            f"✅ embed-text: Rate limit acquired",
            request_id=request_id,
            wait_time_ms=round(wait_time * 1000, 2),
            acquire_duration_ms=round(rate_limit_duration * 1000, 2)
        )
        
        # Truncate text if necessary
        processed_text = truncate_text(input.text)
        
        log_with_context(
            "INFO",
            "🚀 embed-text: Calling Gemini API...",
            request_id=request_id,
            processed_text_length=len(processed_text),
            model=GEMINI_MODEL,
            dimension=EMBEDDING_DIMENSION
        )
        
        # Generate embedding - this is where timeouts typically occur
        gemini_start = time.time()
        try:
            response = client.models.embed_content(
                model=GEMINI_MODEL,
                contents=processed_text,
                config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSION)
            )
            gemini_duration = time.time() - gemini_start
            
            log_with_context(
                "INFO",
                f"✅ embed-text: Gemini API responded",
                request_id=request_id,
                gemini_duration_ms=round(gemini_duration * 1000, 2),
                has_embeddings=bool(response.embeddings),
                embedding_count=len(response.embeddings) if response.embeddings else 0
            )
            
        except Exception as gemini_error:
            gemini_duration = time.time() - gemini_start
            log_with_context(
                "ERROR",
                f"💥 embed-text: Gemini API call failed",
                request_id=request_id,
                gemini_duration_ms=round(gemini_duration * 1000, 2),
                error=str(gemini_error),
                error_type=type(gemini_error).__name__,
                traceback=traceback.format_exc()
            )
            raise
        
        if not response.embeddings:
            log_with_context(
                "ERROR",
                "❌ embed-text: No embedding data in Gemini response",
                request_id=request_id,
                response_type=type(response).__name__
            )
            raise HTTPException(status_code=500, detail="No embedding data received from Gemini")
        
        embedding = response.embeddings[0].values
        normalized_embedding = l2_normalize_embedding(embedding)
        processing_time = time.time() - start_time
        
        metrics.requests_success += 1
        metrics.total_processing_time_ms += processing_time * 1000
        
        log_with_context(
            "INFO",
            f"✅ embed-text: Embedding generated successfully",
            request_id=request_id,
            processing_time_ms=round(processing_time * 1000, 2),
            embedding_dimension=len(normalized_embedding),
            rate_limit_wait_ms=round(wait_time * 1000, 2) if wait_time > 0 else 0
        )
        
        return EmbeddingResponse(
            embedding=normalized_embedding,
            dimension=len(normalized_embedding),
            model=GEMINI_MODEL,
            text=processed_text,
            processing_time=processing_time,
            rate_limit_wait_time=wait_time if wait_time > 0 else None
        )
        
    except HTTPException:
        metrics.requests_failed += 1
        raise
    except Exception as e:
        metrics.requests_failed += 1
        processing_time = time.time() - start_time
        
        if is_rate_limit_error(e):
            metrics.gemini_rate_limit_errors += 1
            log_with_context(
                "ERROR",
                f"🚨 embed-text: Gemini rate limit error",
                request_id=request_id,
                error=str(e),
                processing_time_ms=round(processing_time * 1000, 2)
            )
            raise HTTPException(
                status_code=429, 
                detail=f"Gemini API rate limit exceeded. Please retry after a moment. Error: {str(e)}"
            )
        else:
            metrics.gemini_other_errors += 1
            log_with_context(
                "ERROR",
                f"❌ embed-text: Unexpected error",
                request_id=request_id,
                error=str(e),
                error_type=type(e).__name__,
                processing_time_ms=round(processing_time * 1000, 2),
                traceback=traceback.format_exc()
            )
            raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")


@app.post("/embed-batch-text", response_model=BatchEmbeddingResponse)
async def embed_batch_text(input: BatchTextInput, request: Request):
    """Generate embeddings for multiple texts with rate limiting"""
    global metrics
    
    request_id = getattr(request.state, 'request_id', 'unknown')
    
    log_with_context(
        "INFO",
        "🔤 embed-batch-text: Starting batch embedding generation",
        request_id=request_id,
        batch_size=len(input.texts),
        total_text_length=sum(len(t) for t in input.texts)
    )
    
    if client is None:
        log_with_context("ERROR", "❌ embed-batch-text: Gemini client not initialized", request_id=request_id)
        raise HTTPException(status_code=503, detail="Gemini client not initialized")
    
    if len(input.texts) == 0:
        raise HTTPException(status_code=400, detail="No texts provided")
    
    if len(input.texts) > MAX_BATCH_SIZE:
        raise HTTPException(status_code=400, detail=f"Batch size too large (max {MAX_BATCH_SIZE})")
    
    metrics.requests_total += 1
    start_time = time.time()
    
    try:
        # Apply rate limiting (waits if necessary)
        rate_limit_start = time.time()
        log_with_context("INFO", "⏳ embed-batch-text: Acquiring rate limit slot...", request_id=request_id)
        wait_time = await rate_limiter.acquire()
        rate_limit_duration = time.time() - rate_limit_start
        
        log_with_context(
            "INFO",
            f"✅ embed-batch-text: Rate limit acquired",
            request_id=request_id,
            wait_time_ms=round(wait_time * 1000, 2),
            acquire_duration_ms=round(rate_limit_duration * 1000, 2)
        )
        
        # Truncate texts if necessary
        processed_texts = [truncate_text(text) for text in input.texts]
        
        log_with_context(
            "INFO",
            "🚀 embed-batch-text: Calling Gemini API...",
            request_id=request_id,
            batch_size=len(processed_texts),
            model=GEMINI_MODEL,
            dimension=EMBEDDING_DIMENSION
        )
        
        # Generate batch embeddings - this is where timeouts typically occur
        gemini_start = time.time()
        try:
            response = client.models.embed_content(
                model=GEMINI_MODEL,
                contents=processed_texts,
                config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSION)
            )
            gemini_duration = time.time() - gemini_start
            
            log_with_context(
                "INFO",
                f"✅ embed-batch-text: Gemini API responded",
                request_id=request_id,
                gemini_duration_ms=round(gemini_duration * 1000, 2),
                has_embeddings=bool(response.embeddings),
                embedding_count=len(response.embeddings) if response.embeddings else 0
            )
            
        except Exception as gemini_error:
            gemini_duration = time.time() - gemini_start
            log_with_context(
                "ERROR",
                f"💥 embed-batch-text: Gemini API call failed",
                request_id=request_id,
                gemini_duration_ms=round(gemini_duration * 1000, 2),
                error=str(gemini_error),
                error_type=type(gemini_error).__name__,
                traceback=traceback.format_exc()
            )
            raise
        
        if not response.embeddings:
            log_with_context(
                "ERROR",
                "❌ embed-batch-text: No embedding data in Gemini response",
                request_id=request_id,
                response_type=type(response).__name__
            )
            raise HTTPException(status_code=500, detail="No embedding data received from Gemini")
        
        # Extract and normalize embeddings
        embeddings = []
        for emb in response.embeddings:
            normalized_embedding = l2_normalize_embedding(emb.values)
            embeddings.append(normalized_embedding)
        
        processing_time = time.time() - start_time
        
        metrics.requests_success += 1
        metrics.total_processing_time_ms += processing_time * 1000
        
        log_with_context(
            "INFO",
            f"✅ embed-batch-text: Batch embeddings generated successfully",
            request_id=request_id,
            processing_time_ms=round(processing_time * 1000, 2),
            embedding_count=len(embeddings),
            embedding_dimension=len(embeddings[0]) if embeddings else 0,
            rate_limit_wait_ms=round(wait_time * 1000, 2) if wait_time > 0 else 0
        )
        
        return BatchEmbeddingResponse(
            embeddings=embeddings,
            dimension=len(embeddings[0]) if embeddings else EMBEDDING_DIMENSION,
            model=GEMINI_MODEL,
            count=len(embeddings),
            processing_time=processing_time,
            tokens_used=0,  # Gemini API doesn't always return token usage
            rate_limit_wait_time=wait_time if wait_time > 0 else None
        )
        
    except HTTPException:
        metrics.requests_failed += 1
        raise
    except Exception as e:
        metrics.requests_failed += 1
        processing_time = time.time() - start_time
        
        if is_rate_limit_error(e):
            metrics.gemini_rate_limit_errors += 1
            log_with_context(
                "ERROR",
                f"🚨 embed-batch-text: Gemini rate limit error",
                request_id=request_id,
                error=str(e),
                processing_time_ms=round(processing_time * 1000, 2)
            )
            raise HTTPException(
                status_code=429, 
                detail=f"Gemini API rate limit exceeded. Please retry after a moment. Error: {str(e)}"
            )
        else:
            metrics.gemini_other_errors += 1
            log_with_context(
                "ERROR",
                f"❌ embed-batch-text: Unexpected error",
                request_id=request_id,
                error=str(e),
                error_type=type(e).__name__,
                processing_time_ms=round(processing_time * 1000, 2),
                traceback=traceback.format_exc()
            )
            raise HTTPException(status_code=500, detail=f"Batch embedding generation failed: {str(e)}")


@app.get("/model-info")
async def model_info():
    """Get information about the Gemini model and service"""
    return {
        "service_name": "Gemini Text Embedding Service",
        "model_name": GEMINI_MODEL,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "max_input_length": MAX_INPUT_LENGTH,
        "max_batch_size": MAX_BATCH_SIZE,
        "api_version": "v1beta",
        "client_initialized": client is not None,
        "rate_limiting": {
            "enabled": True,
            "max_requests": RATE_LIMIT_REQUESTS,
            "window_seconds": RATE_LIMIT_WINDOW_SECONDS,
            "burst_size": RATE_LIMIT_BURST_SIZE,
        }
    }


@app.get("/metrics")
async def get_metrics():
    """Get service metrics for monitoring"""
    uptime_seconds = (datetime.now() - metrics.start_time).total_seconds()
    
    return {
        "service": {
            "uptime_seconds": uptime_seconds,
            "start_time": metrics.start_time.isoformat(),
        },
        "requests": {
            "total": metrics.requests_total,
            "success": metrics.requests_success,
            "failed": metrics.requests_failed,
            "success_rate": (
                metrics.requests_success / metrics.requests_total * 100 
                if metrics.requests_total > 0 else 100
            ),
        },
        "errors": {
            "gemini_rate_limits": metrics.gemini_rate_limit_errors,
            "gemini_other": metrics.gemini_other_errors,
        },
        "performance": {
            "avg_processing_time_ms": (
                metrics.total_processing_time_ms / metrics.requests_success 
                if metrics.requests_success > 0 else 0
            ),
            "requests_per_second": (
                metrics.requests_total / uptime_seconds if uptime_seconds > 0 else 0
            ),
        },
        "rate_limiter": rate_limiter.get_stats(),
    }


@app.post("/metrics/reset")
async def reset_metrics():
    """Reset service metrics"""
    global metrics
    metrics = ServiceMetrics()
    rate_limiter.reset_stats()
    return {"status": "metrics_reset", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 8001)),
        reload=False,
        log_level="info"
    )
