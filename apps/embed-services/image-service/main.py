#!/usr/bin/env python3
"""
SigLIP Image Embedding Service
Provides image embeddings using SigLIP ViT-SO400M-14 model.
"""

from fastapi import FastAPI, UploadFile, HTTPException
from pydantic import BaseModel, Field
import torch
from transformers import AutoProcessor, AutoModel
from peft import PeftModel
from PIL import Image
import io
import uvicorn
import logging
import time
import os
import json
import requests
import asyncio
import aiohttp
from typing import List, Optional
from contextlib import asynccontextmanager

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
MODEL_NAME = "google/siglip-so400m-patch14-384"
LORA_MODEL_PATH = os.path.join(os.path.dirname(__file__), "lora_siglip_model")
EMBEDDING_DIMENSION = 1152  # SigLIP ViT-SO400M-14 dimension
MAX_BATCH_SIZE = 32  # Reasonable batch size for image processing
IMAGE_SIZE = 384  # SigLIP input size

def load_lora_model(lora_path: str, device: str = None):
    """
    Utility function to load a fine-tuned LoRA model for inference.

    Args:
        lora_path: Path to the saved LoRA model directory
        device: Device to load model on

    Returns:
        model, processor
    """
    if device is None:
        device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")

    # Load config
    with open(f"{lora_path}/lora_config.json", 'r') as f:
        config = json.load(f)

    # Load base model
    logger.info(f"Loading base model: {config['model_name']}")
    base_model = AutoModel.from_pretrained(config['model_name'])

    # Load LoRA adapters
    logger.info(f"Loading LoRA adapters from: {lora_path}")
    model = PeftModel.from_pretrained(base_model, lora_path)
    model.to(device)
    model.eval()

    # Load processor
    processor = AutoProcessor.from_pretrained(lora_path)

    logger.info("✓ Model loaded successfully")
    return model, processor

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize SigLIP model on startup and cleanup on shutdown"""
    global device, model, processor
    
    try:
        # Check CUDA first (for NVIDIA GPUs), then MPS (for Apple Silicon), then CPU
        print("torch.cuda.is_available():", torch.cuda.is_available())
        print("torch.backends.mps.is_available():", torch.backends.mps.is_available())
        device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
        logger.info(f"Loading LoRA fine-tuned SigLIP model on device: {device}")
        
        # Load LoRA fine-tuned model and processor
        model, processor = load_lora_model(LORA_MODEL_PATH, device=device)
        
        logger.info("LoRA fine-tuned SigLIP model loaded successfully")
        logger.info(f"Base model: {MODEL_NAME}")
        logger.info(f"LoRA path: {LORA_MODEL_PATH}")
        logger.info(f"Device: {device}")
        logger.info(f"Embedding dimension: {EMBEDDING_DIMENSION}")
        logger.info(f"Input image size: {IMAGE_SIZE}x{IMAGE_SIZE}")
        logger.info(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")
        
        yield
        
    except Exception as e:
        logger.error(f"Failed to load LoRA fine-tuned SigLIP model: {e}")
        raise
    finally:
        logger.info("Shutting down SigLIP Image Embedding Service")

app = FastAPI(
    title="SigLIP Image Embedding Service",
    description="High-performance image embeddings using LoRA fine-tuned SigLIP ViT-SO400M-14 model",
    version="1.0.0",
    lifespan=lifespan
)

# Global model variables
device = None
model = None
processor = None

class ImageUrlInput(BaseModel):
    url: str = Field(..., description="Image URL to embed")
    timeout: Optional[int] = Field(15, description="Download timeout in seconds")

class BatchImageUrlInput(BaseModel):
    urls: List[str] = Field(..., description="List of image URLs to embed", max_items=MAX_BATCH_SIZE)
    timeout: Optional[int] = Field(15, description="Download timeout in seconds")
    max_concurrent: Optional[int] = Field(5, description="Maximum concurrent downloads")

class TextInput(BaseModel):
    text: str = Field(..., description="Text to embed using SigLIP text encoder")

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    embedding_dimension: int
    max_batch_size: int
    model_loaded: bool

class EmbeddingResponse(BaseModel):
    embedding: List[float]
    dimension: int
    model: str
    processing_time: float
    image_size: Optional[tuple] = None

class BatchEmbeddingResponse(BaseModel):
    embeddings: List[Optional[List[float]]]
    dimension: int
    model: str
    count: int
    successful_count: int
    failed_count: int
    processing_time: float
    errors: List[dict] = []

def preprocess_image(image: Image.Image) -> torch.Tensor:
    """Preprocess image for SigLIP model"""
    # Convert to RGB if necessary
    if image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Process with SigLIP processor
    inputs = processor(images=image, return_tensors="pt")
    return inputs.pixel_values.to(device)

def generate_embedding(image_tensor: torch.Tensor) -> List[float]:
    """Generate embedding from preprocessed image tensor"""
    with torch.no_grad():
        # Get image features from SigLIP
        image_features = model.get_image_features(pixel_values=image_tensor)
        
        # Normalize the features (SigLIP typically uses normalized embeddings)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        
        # Convert to list
        embedding = image_features.cpu().numpy()[0].tolist()
        
    return embedding

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy" if model is not None else "error",
        model=MODEL_NAME,
        device=device or "unknown",
        embedding_dimension=EMBEDDING_DIMENSION,
        max_batch_size=MAX_BATCH_SIZE,
        model_loaded=model is not None
    )

@app.post("/embed-image", response_model=EmbeddingResponse)
async def embed_image(file: UploadFile):
    """Generate embedding for an uploaded image"""
    start_time = time.time()
    
    logger.info(f"🖼️ Starting image embedding for file: {file.filename}, content_type: {file.content_type}")
    
    if model is None:
        logger.error("Model not loaded when trying to embed image")
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    # Validate file type
    if not file.content_type or not file.content_type.startswith('image/'):
        logger.error(f"Invalid file type: {file.content_type}")
        raise HTTPException(status_code=400, detail="File must be an image")
    
    try:
        # Read and process image
        img_bytes = await file.read()
        image = Image.open(io.BytesIO(img_bytes))
        original_size = image.size
        
        logger.info(f"📥 Image loaded: mode={image.mode}, size={image.size}, format={image.format}")
        
        # Preprocess image
        image_tensor = preprocess_image(image)
        
        # Generate embedding
        embedding = generate_embedding(image_tensor)
        
        processing_time = time.time() - start_time
        
        logger.info(f"✅ Image embedding completed in {processing_time:.3f}s, dimension: {len(embedding)}")
        
        return EmbeddingResponse(
            embedding=embedding,
            dimension=len(embedding),
            model=MODEL_NAME,
            processing_time=processing_time,
            image_size=original_size
        )
        
    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"❌ Error embedding image after {processing_time:.3f}s: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Image embedding failed: {str(e)}")

@app.post("/embed-image-url", response_model=EmbeddingResponse)
async def embed_image_url(input: ImageUrlInput):
    """Generate embedding for an image from URL"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    start_time = time.time()
    
    try:
        logger.info(f"🌐 Downloading image from URL: {input.url}")
        
        # Download image
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=input.timeout),
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Referer': 'https://www.google.com/'
            }
        ) as session:
            async with session.get(input.url) as response:
                if response.status != 200:
                    raise HTTPException(status_code=400, detail=f"Failed to download image: HTTP {response.status}")
                
                img_bytes = await response.read()
        
        # Process image
        image = Image.open(io.BytesIO(img_bytes))
        original_size = image.size
        
        logger.info(f"📥 Image downloaded and loaded: mode={image.mode}, size={image.size}")
        
        # Preprocess and embed
        image_tensor = preprocess_image(image)
        embedding = generate_embedding(image_tensor)
        
        processing_time = time.time() - start_time
        
        logger.info(f"✅ URL image embedding completed in {processing_time:.3f}s")
        
        return EmbeddingResponse(
            embedding=embedding,
            dimension=len(embedding),
            model=MODEL_NAME,
            processing_time=processing_time,
            image_size=original_size
        )
        
    except HTTPException:
        raise
    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"❌ Error embedding image from URL after {processing_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Image embedding failed: {str(e)}")

async def download_and_process_image_siglip(session: aiohttp.ClientSession, url: str, timeout: int = 15):
    """Download and process a single image from URL for SigLIP"""
    try:
        timeout_config = aiohttp.ClientTimeout(total=timeout)
        async with session.get(url, timeout=timeout_config) as response:
            if response.status != 200:
                raise Exception(f"HTTP {response.status}: {response.reason}")
            
            img_bytes = await response.read()
            
            # Open and process image
            image = Image.open(io.BytesIO(img_bytes))
            original_size = image.size
            
            # Preprocess for SigLIP
            image_tensor = preprocess_image(image)
            
            # Generate embedding
            embedding = generate_embedding(image_tensor)
            
            return {
                "success": True,
                "embedding": embedding,
                "url": url,
                "image_size": original_size,
                "image_mode": image.mode
            }
            
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "url": url,
            "embedding": None
        }

@app.post("/embed-batch-image-urls", response_model=BatchEmbeddingResponse)
async def embed_batch_image_urls(input: BatchImageUrlInput):
    """Generate embeddings for multiple images from URLs (more efficient)"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if len(input.urls) == 0:
        raise HTTPException(status_code=400, detail="No URLs provided")
    
    if len(input.urls) > MAX_BATCH_SIZE:
        raise HTTPException(status_code=400, detail=f"Batch size too large (max {MAX_BATCH_SIZE} images)")
    
    start_time = time.time()
    logger.info(f"🖼️ Starting batch image embedding for {len(input.urls)} URLs")
    
    try:
        # Create semaphore to limit concurrent downloads
        semaphore = asyncio.Semaphore(input.max_concurrent)
        
        async def process_with_semaphore(session, url):
            async with semaphore:
                return await download_and_process_image_siglip(session, url, input.timeout)
        
        # Process all images concurrently with limit
        async with aiohttp.ClientSession(
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Referer': 'https://www.google.com/'
            }
        ) as session:
            tasks = [process_with_semaphore(session, url) for url in input.urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Process results
        embeddings = []
        errors = []
        successful_count = 0
        
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                errors.append({
                    "url": input.urls[i],
                    "error": str(result)
                })
                embeddings.append(None)
            elif result["success"]:
                embeddings.append(result["embedding"])
                successful_count += 1
            else:
                errors.append({
                    "url": result["url"],
                    "error": result["error"]
                })
                embeddings.append(None)
        
        processing_time = time.time() - start_time
        logger.info(f"✅ Batch image embedding completed in {processing_time:.3f}s: {successful_count}/{len(input.urls)} successful")
        
        return BatchEmbeddingResponse(
            embeddings=embeddings,
            dimension=EMBEDDING_DIMENSION,
            model=MODEL_NAME,
            count=len(embeddings),
            successful_count=successful_count,
            failed_count=len(errors),
            processing_time=processing_time,
            errors=errors
        )
        
    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"❌ Error in batch image embedding after {processing_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Batch image embedding failed: {str(e)}")

@app.post("/embed-text", response_model=EmbeddingResponse)
async def embed_text(input: TextInput):
    """Generate embedding for text using SigLIP text encoder"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if not input.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    
    start_time = time.time()
    logger.info(f"📝 Starting text embedding for text: '{input.text[:50]}{'...' if len(input.text) > 50 else ''}'")
    
    try:
        # Process text using SigLIP processor
        # SigLIP was trained with fixed-length text, including its padding tokens.
        text_inputs = processor(
            text=[input.text], return_tensors="pt", padding="max_length",
            truncation=True, max_length=model.config.text_config.max_position_embeddings,
        )
        text_inputs = {k: v.to(device) for k, v in text_inputs.items()}
        
        # Generate text embedding
        with torch.no_grad():
            text_features = model.get_text_features(**text_inputs)
            # L2 normalize the features
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        
        # Convert to list
        embedding = text_features.cpu().numpy().flatten().tolist()
        processing_time = time.time() - start_time
        
        logger.info(f"✅ Text embedding generated successfully in {processing_time:.3f}s")
        
        return EmbeddingResponse(
            embedding=embedding,
            dimension=len(embedding),
            model=MODEL_NAME,
            processing_time=processing_time,
            image_size=None  # Not applicable for text
        )
        
    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"❌ Error in text embedding after {processing_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Text embedding failed: {str(e)}")

@app.get("/model-info")
async def model_info():
    """Get information about the loaded model"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    return {
        "service_name": "SigLIP Image Embedding Service",
        "model_name": MODEL_NAME,
        "lora_model_path": LORA_MODEL_PATH,
        "is_lora_model": True,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "input_image_size": IMAGE_SIZE,
        "max_batch_size": MAX_BATCH_SIZE,
        "device": device,
        "pytorch_version": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "cuda_device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0,
        "model_loaded": model is not None
    }

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 8002)),
        reload=False,
        log_level="info"
    )
