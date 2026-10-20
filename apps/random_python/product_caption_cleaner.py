"""
Product Caption Cleaner

This module provides functionality to clean messy product descriptions using OpenAI's API.
It connects to a PostgreSQL database to fetch product data and returns cleaned captions
suitable for computer vision models.
"""

import os
import time
import psycopg2
from typing import Optional, Dict, Any, List, Callable
from openai import OpenAI

# Try to import RateLimitError - it may be in different locations depending on SDK version
try:
    from openai import RateLimitError
except ImportError:
    try:
        from openai.error import RateLimitError
    except ImportError:
        # Fallback: we'll check status codes manually
        RateLimitError = None

# Database configuration - matches the config from the notebook
DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'database': 'find_db',
    'user': 'postgres',
    # 'password': 'password'  # Uncomment and update if password is required
}

# OpenAI prompt template
CLEANING_PROMPT = """
You are an expert fashion copy editor. Your task is to reformat messy product descriptions for a computer vision model.

The goal is to create a single, concise, and factual caption that ONLY describes the visual attributes of the item. This caption will be used to teach a model to match an image to the text.

**Instructions:**

1. Identify Visual Attributes: Extract the main item type, color, material, style, and any key patterns or details (like zippers, logos, or prints).
2. Write a New Caption: Combine the visual attributes into a clean, descriptive sentence.
3. Be Literal: Describe the item as if you are describing a photograph to someone who cannot see it.
4. Do not add any additional information to the caption that is not present in the messy input.

**What to STRICTLY EXCLUDE:**

1. All Sizes: S, M, L, XL, 32, 10, etc.
2. All Subjective Feelings: "Cozy," "beautiful," "amazing," "high-quality," "perfect for..."
3. All Inferred Uses: "Suitable for winter," "great for a party," "good for work."
4. All Marketing/Logistics: "Bestseller," "on sale," "SKU," "free shipping."
5. All Brand Names: "Nike," "Adidas," "Gucci," "Prada," etc.
6. All mentions of the condition of the item: "new," "used," "like new," "excellent condition," "good condition," "poor condition," etc.
7. All numbers: "100%," "2-day shipping," "32," "10," etc.
---

**Example 1:**
[MESSY INPUT]: "MUST HAVE!! Our new L-45 sneaker is finally here!! Amazing quality, you will love it. Suede and leather. Red and white. SKU: 45A-88. Free shipping this week only. Buy now!"
[CLEANED CAPTION]: A red and white sneaker with suede and leather panels and white laces.

**Example 2:**
[MESSY INPUT]: "Beautiful dress for summer. 100% cotton, so comfy. Blue floral print in size small. This v-neck maxi dress is our bestseller and perfect for a party or the beach. Get it before it's gone!!"
[CLEANED CAPTION]: A blue and white floral print maxi dress with a v-neck and short sleeves, made of cotton.

**Example 3:**
[MESSY INPUT]: "High-quality PU leather bag. Black. Great for work or school. Lots of pockets. Our best tote bag. 2-day shipping. Model: TOTE-BLK-01."
[CLEANED CAPTION]: A black PU leather tote bag featuring top handles and exterior pockets.

---

Now, please clean the following messy description using the same rules.

[MESSY INPUT]:
{messy_input}

[CLEANED CAPTION]:
"""

# Text augmentation prompt template
AUGMENTATION_PROMPT = """
You are an AI assistant specializing in text augmentation for computer vision models. Your task is to rephrase the provided clean fashion caption in 3 different ways.

Crucial Rules:

Factually Identical: The rephrased captions must be 100% semantically identical to the original.

Keep All Details: You must keep all factual visual details (like item, color, material, style, and print).

No New Information: Do not add any new facts, adjectives, or information.

No Subjective Words: Do not add any subjective ("beautiful," "cozy") or non-visual ("XL," "for winter") words.

Example 1: [ORIGINAL]: "A blue and white floral print cotton maxi dress with a v-neck." [OUTPUT]:

A v-neck maxi dress made of cotton with a blue and white floral pattern.

This cotton maxi dress features a v-neck and a blue and white floral print.

A floral print maxi dress in blue and white, made of cotton with a v-neck.

Example 2: [ORIGINAL]: "A red leather ankle boot with a side zipper and stiletto heel." [OUTPUT]:

An ankle boot made of red leather, featuring a stiletto heel and a side zipper.

A stiletto heel ankle boot in red leather with a zipper on the side.

A red leather boot with an ankle-high cut, side zip, and stiletto heel.

Now, please rephrase the following caption using these exact rules.

[ORIGINAL]: {original_caption}

[OUTPUT]:
"""


class ProductCaptionCleaner:
    """
    A class to handle cleaning product descriptions using OpenAI's API.
    """
    
    def __init__(self, openai_api_key: Optional[str] = None, db_config: Optional[Dict[str, Any]] = None):
        """
        Initialize the ProductCaptionCleaner.
        
        Args:
            openai_api_key: OpenAI API key. If None, will try to get from OPENAI_API_KEY env var.
            db_config: Database configuration dict. If None, uses default DB_CONFIG.
        """
        # Initialize OpenAI client
        api_key = openai_api_key or os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError("OpenAI API key must be provided either as parameter or OPENAI_API_KEY environment variable")
        
        self.client = OpenAI(api_key=api_key)
        self.db_config = db_config or DB_CONFIG
    
    def _call_with_retry(self, api_call: Callable, max_retries: int = 5, initial_delay: float = 1.0) -> Any:
        """
        Execute an API call with exponential backoff retry logic for rate limit errors.
        
        Args:
            api_call: A callable that makes the OpenAI API call
            max_retries: Maximum number of retry attempts (default: 5)
            initial_delay: Initial delay in seconds before first retry (default: 1.0)
            
        Returns:
            The result of the API call
            
        Raises:
            Exception: If all retries are exhausted or a non-rate-limit error occurs
        """
        delay = initial_delay
        
        for attempt in range(max_retries + 1):
            try:
                return api_call()
            except Exception as e:
                # Check if this is a rate limit error (429)
                is_rate_limit = False
                
                # Check for RateLimitError exception (newer SDK versions)
                if RateLimitError and isinstance(e, RateLimitError):
                    is_rate_limit = True
                # Check for status code 429 (fallback for different exception structures)
                elif hasattr(e, 'status_code') and e.status_code == 429:
                    is_rate_limit = True
                elif hasattr(e, 'response') and hasattr(e.response, 'status_code') and e.response.status_code == 429:
                    is_rate_limit = True
                
                if is_rate_limit:
                    if attempt < max_retries:
                        wait_time = delay * (2 ** attempt)  # Exponential backoff
                        print(f"Rate limit hit (429). Retrying in {wait_time:.1f} seconds... (attempt {attempt + 1}/{max_retries + 1})")
                        time.sleep(wait_time)
                    else:
                        raise Exception(f"Rate limit exceeded after {max_retries + 1} attempts: {e}")
                else:
                    # For non-rate-limit errors, don't retry
                    raise
    
    def get_database_connection(self):
        """
        Create and return a database connection.
        
        Returns:
            psycopg2 connection object
        """
        try:
            conn = psycopg2.connect(**self.db_config)
            return conn
        except psycopg2.Error as e:
            raise Exception(f"Failed to connect to database: {e}")
    
    def fetch_product_by_id(self, product_id: int) -> Optional[Dict[str, str]]:
        """
        Fetch product title, description, color_norm, and primary_material_norm from database by ID.
        
        Args:
            product_id: The ID of the product to fetch
            
        Returns:
            Dict with 'title', 'description', 'color_norm', and 'primary_material_norm' keys, or None if product not found
        """
        conn = None
        try:
            conn = self.get_database_connection()
            cursor = conn.cursor()
            
            query = "SELECT title, description, color_norm, primary_material_norm FROM products WHERE id = %s"
            cursor.execute(query, (product_id,))
            
            result = cursor.fetchone()
            if result:
                return {
                    'title': result[0] or '',
                    'description': result[1] or '',
                    'color_norm': result[2] or '',
                    'primary_material_norm': result[3] or ''
                }
            else:
                return None
                
        except psycopg2.Error as e:
            raise Exception(f"Database error: {e}")
        finally:
            if conn:
                conn.close()
    
    def clean_description_with_openai(self, messy_input: str, color_norm: str = "", primary_material_norm: str = "") -> str:
        """
        Clean a messy product description using OpenAI's API.
        
        Args:
            messy_input: The messy product description to clean
            color_norm: Normalized color information from database
            primary_material_norm: Normalized primary material information from database
            
        Returns:
            Cleaned caption suitable for computer vision models
        """
        try:
            # Add normalized data to the input if available
            enhanced_input = messy_input
            if color_norm or primary_material_norm:
                additional_info = []
                if color_norm:
                    additional_info.append(f"Color: {color_norm}")
                if primary_material_norm:
                    additional_info.append(f"Material: {primary_material_norm}")
                
                enhanced_input = f"{messy_input}\n\nAdditional normalized product data: {', '.join(additional_info)}"
            
            prompt = CLEANING_PROMPT.format(messy_input=enhanced_input)
            
            # Use retry logic for rate limit handling
            response = self._call_with_retry(
                lambda: self.client.chat.completions.create(
                    model="gpt-5-nano",
                    messages=[
                        {"role": "user", "content": prompt}
                    ],
                    max_tokens=300,
                    temperature=0.1  # Low temperature for consistent, factual outputs
                )
            )
            
            cleaned_caption = response.choices[0].message.content.strip()
            
            # Remove any remaining "[CLEANED CAPTION]:" prefix if present
            if cleaned_caption.startswith("[CLEANED CAPTION]:"):
                cleaned_caption = cleaned_caption.replace("[CLEANED CAPTION]:", "").strip()
            
            return cleaned_caption
            
        except Exception as e:
            raise Exception(f"OpenAI API error: {e}")
    
    def generate_alternative_captions(self, original_caption: str) -> List[str]:
        """
        Generate 3 alternative versions of a clean caption for text augmentation.
        
        Args:
            original_caption: The original clean caption to rephrase
            
        Returns:
            List of 3 alternative captions
        """
        try:
            prompt = AUGMENTATION_PROMPT.format(original_caption=original_caption)
            
            # Use retry logic for rate limit handling
            response = self._call_with_retry(
                lambda: self.client.chat.completions.create(
                    model="gpt-5-nano",
                    messages=[
                        {"role": "user", "content": prompt}
                    ],
                    max_tokens=400,
                    temperature=0.3  # Slightly higher temperature for more variation while staying factual
                )
            )
            
            response_text = response.choices[0].message.content.strip()
            
            # Parse the response to extract the 3 alternatives
            # The response should contain 3 lines, each being an alternative
            alternatives = []
            lines = response_text.split('\n')
            
            for line in lines:
                line = line.strip()
                if line and not line.startswith('[') and not line.startswith('Example'):
                    alternatives.append(line)
            
            # Return exactly 3 alternatives, pad with original if needed
            while len(alternatives) < 3:
                alternatives.append(original_caption)
            
            return alternatives[:3]  # Return only first 3
            
        except Exception as e:
            print(f"Error generating alternative captions: {e}")
            # Return original caption 3 times as fallback
            return [original_caption, original_caption, original_caption]
    
    def get_all_product_ids(self, limit: Optional[int] = None) -> List[int]:
        """
        Fetch all product IDs from the database.
        
        Args:
            limit: Optional limit on number of product IDs to return
            
        Returns:
            List of product IDs
        """
        conn = None
        try:
            conn = self.get_database_connection()
            cursor = conn.cursor()
            
            if limit:
                query = "SELECT id FROM products where clean_text_captions is null ORDER BY id LIMIT %s"
                cursor.execute(query, (limit,))
            else:
                query = "SELECT id FROM products where clean_text_captions is null ORDER BY id"
                cursor.execute(query)
            
            results = cursor.fetchall()
            return [row[0] for row in results]
                
        except psycopg2.Error as e:
            raise Exception(f"Database error: {e}")
        finally:
            if conn:
                conn.close()
    
    def update_product_captions(self, product_id: int, original: str, alt1: str, alt2: str, alt3: str) -> bool:
        """
        Update the clean caption columns for a specific product.
        
        Args:
            product_id: The ID of the product to update
            original: Original cleaned caption
            alt1: First alternative caption
            alt2: Second alternative caption
            alt3: Third alternative caption
            
        Returns:
            True if successful, False otherwise
        """
        conn = None
        try:
            conn = self.get_database_connection()
            cursor = conn.cursor()
            
            query = """
                UPDATE products 
                SET clean_text_captions = %s,
                    clean_text_captions1 = %s,
                    clean_text_captions2 = %s,
                    clean_text_captions3 = %s
                WHERE id = %s
            """
            
            cursor.execute(query, (original, alt1, alt2, alt3, product_id))
            conn.commit()
            
            return cursor.rowcount > 0
                
        except psycopg2.Error as e:
            print(f"Database error updating product {product_id}: {e}")
            return False
        finally:
            if conn:
                conn.close()
    
    def process_all_products(self, limit: Optional[int] = None) -> Dict[str, int]:
        """
        Process all products in the database and update their clean caption columns.
        
        Args:
            limit: Optional limit on number of products to process (for testing)
            
        Returns:
            Dict with processing statistics
        """
        print(f"Starting batch processing of products...")
        if limit:
            print(f"Processing limit: {limit} products")
        
        # Get all product IDs
        try:
            product_ids = self.get_all_product_ids(limit)
            total_products = len(product_ids)
            print(f"Found {total_products} products to process")
        except Exception as e:
            print(f"Error fetching product IDs: {e}")
            return {"total": 0, "processed": 0, "failed": 0, "skipped": 0}
        
        if total_products == 0:
            print("No products found to process")
            return {"total": 0, "processed": 0, "failed": 0, "skipped": 0}
        
        # Process each product
        processed = 0
        failed = 0
        skipped = 0
        
        for i, product_id in enumerate(product_ids, 1):
            print(f"Processing product {product_id} ({i}/{total_products})...")
            
            try:
                # Generate cleaned caption with alternatives
                result = self.clean_product_caption_with_alternatives(product_id)
                
                if result:
                    original = result['original']
                    alternatives = result['alternatives']
                    
                    # Ensure we have exactly 3 alternatives
                    while len(alternatives) < 3:
                        alternatives.append(original)
                    
                    # Update database
                    success = self.update_product_captions(
                        product_id, 
                        original, 
                        alternatives[0], 
                        alternatives[1], 
                        alternatives[2]
                    )
                    
                    if success:
                        processed += 1
                        print(f"  ✓ Successfully processed product {product_id}")
                    else:
                        failed += 1
                        print(f"  ✗ Failed to update database for product {product_id}")
                else:
                    skipped += 1
                    print(f"  - Skipped product {product_id} (no data or processing failed)")
                    
            except Exception as e:
                failed += 1
                print(f"  ✗ Error processing product {product_id}: {e}")
            
            # Progress update every 10 products
            if i % 10 == 0:
                print(f"Progress: {i}/{total_products} products processed")
        
        # Final statistics
        stats = {
            "total": total_products,
            "processed": processed,
            "failed": failed,
            "skipped": skipped
        }
        
        print(f"\nBatch processing completed!")
        print(f"Total products: {stats['total']}")
        print(f"Successfully processed: {stats['processed']}")
        print(f"Failed: {stats['failed']}")
        print(f"Skipped: {stats['skipped']}")
        
        return stats
    
    def clean_product_caption(self, product_id: int) -> Optional[str]:
        """
        Main function: Fetch product by ID and return cleaned caption.
        
        Args:
            product_id: The ID of the product to process
            
        Returns:
            Cleaned caption string, or None if product not found
        """
        # Fetch product data
        product_data = self.fetch_product_by_id(product_id)
        if not product_data:
            print(f"Product with ID {product_id} not found")
            return None
        
        # Extract all product data
        title = product_data['title']
        description = product_data['description']
        color_norm = product_data['color_norm']
        primary_material_norm = product_data['primary_material_norm']
        
        # Create combined input for cleaning
        messy_input = f"{title}. {description}".strip()
        
        if not messy_input or messy_input == ".":
            print(f"No title or description found for product ID {product_id}")
            return None
        
        # Clean the description with normalized data
        try:
            cleaned_caption = self.clean_description_with_openai(
                messy_input, 
                color_norm=color_norm, 
                primary_material_norm=primary_material_norm
            )
            return cleaned_caption
        except Exception as e:
            print(f"Error cleaning caption for product ID {product_id}: {e}")
            return None
    
    def clean_product_caption_with_alternatives(self, product_id: int) -> Optional[Dict[str, Any]]:
        """
        Main function: Fetch product by ID and return cleaned caption with 3 alternatives.
        
        Args:
            product_id: The ID of the product to process
            
        Returns:
            Dict with 'original' caption and 'alternatives' list, or None if product not found
        """
        # Get the original cleaned caption
        original_caption = self.clean_product_caption(product_id)
        
        if not original_caption:
            return None
        
        # Generate alternatives
        try:
            alternatives = self.generate_alternative_captions(original_caption)
            
            return {
                'original': original_caption,
                'alternatives': alternatives,
                'product_id': product_id
            }
        except Exception as e:
            print(f"Error generating alternatives for product ID {product_id}: {e}")
            return {
                'original': original_caption,
                'alternatives': [original_caption, original_caption, original_caption],
                'product_id': product_id
            }


def clean_product_caption(product_id: int, openai_api_key: Optional[str] = None) -> Optional[str]:
    """
    Convenience function to clean a product caption by ID.
    
    Args:
        product_id: The ID of the product to process
        openai_api_key: OpenAI API key. If None, will try to get from OPENAI_API_KEY env var.
        
    Returns:
        Cleaned caption string, or None if product not found or error occurred
    """
    cleaner = ProductCaptionCleaner(openai_api_key=openai_api_key)
    return cleaner.clean_product_caption(product_id)


def clean_product_caption_with_alternatives(product_id: int, openai_api_key: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Convenience function to clean a product caption by ID and generate 3 alternatives.
    
    Args:
        product_id: The ID of the product to process
        openai_api_key: OpenAI API key. If None, will try to get from OPENAI_API_KEY env var.
        
    Returns:
        Dict with 'original' caption and 'alternatives' list, or None if product not found
    """
    cleaner = ProductCaptionCleaner(openai_api_key=openai_api_key)
    return cleaner.clean_product_caption_with_alternatives(product_id)


def process_all_products_batch(limit: Optional[int] = None, openai_api_key: Optional[str] = None) -> Dict[str, int]:
    """
    Convenience function to process all products in batch and update database.
    
    Args:
        limit: Optional limit on number of products to process (for testing)
        openai_api_key: OpenAI API key. If None, will try to get from OPENAI_API_KEY env var.
        
    Returns:
        Dict with processing statistics
    """
    cleaner = ProductCaptionCleaner(openai_api_key=openai_api_key)
    return cleaner.process_all_products(limit)


if __name__ == "__main__":
    """
    Example usage and testing
    """
    import sys
    
    def print_usage():
        print("Usage:")
        print("  python product_caption_cleaner.py <product_id> [--alternatives]")
        print("    Process a single product")
        print("    <product_id>: ID of the product to process")
        print("    --alternatives: Generate 3 alternative captions for text augmentation")
        print("")
        print("  python product_caption_cleaner.py --batch [--limit N]")
        print("    Process all products in batch and update database")
        print("    --limit N: Optional limit on number of products to process (for testing)")
        print("")
        print("Make sure to set OPENAI_API_KEY environment variable")
    
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(1)
    
    # Check if API key is set
    if not os.getenv('OPENAI_API_KEY'):
        print("Error: OPENAI_API_KEY environment variable not set")
        print("Set it with: export OPENAI_API_KEY='your-api-key-here'")
        sys.exit(1)
    
    try:
        # Batch processing mode
        if sys.argv[1] == "--batch":
            limit = None
            
            # Check for limit parameter
            if len(sys.argv) >= 4 and sys.argv[2] == "--limit":
                try:
                    limit = int(sys.argv[3])
                    print(f"Batch processing with limit: {limit} products")
                except ValueError:
                    print("Error: Limit must be a valid integer")
                    sys.exit(1)
            elif len(sys.argv) == 2:
                print("Batch processing all products...")
            else:
                print_usage()
                sys.exit(1)
            
            # Run batch processing
            stats = process_all_products_batch(limit=limit)
            
            # Exit with appropriate code
            if stats['failed'] > 0:
                sys.exit(1)  # Some failures occurred
            else:
                sys.exit(0)  # All successful
        
        # Single product processing mode
        else:
            try:
                product_id = int(sys.argv[1])
            except ValueError:
                print("Error: Product ID must be a valid integer")
                print_usage()
                sys.exit(1)
            
            use_alternatives = True  # Always use alternatives as per user's change
            
            print(f"Cleaning caption for product ID: {product_id}")
            
            if use_alternatives:
                print("Generating alternatives for text augmentation...")
                result = clean_product_caption_with_alternatives(product_id)
                
                if result:
                    print(f"\nOriginal Cleaned Caption:")
                    print(f"'{result['original']}'")
                    print(f"\nAlternative Captions:")
                    for i, alt in enumerate(result['alternatives'], 1):
                        print(f"{i}. '{alt}'")
                else:
                    print("Failed to clean caption")
                    sys.exit(1)
            else:
                cleaned_caption = clean_product_caption(product_id)
                
                if cleaned_caption:
                    print(f"\nCleaned Caption:")
                    print(f"'{cleaned_caption}'")
                else:
                    print("Failed to clean caption")
                    sys.exit(1)
            
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
