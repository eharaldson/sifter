import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import dotenv from 'dotenv';
import { initializeDatabase, closeDatabase } from './db';
import { logger } from './log';
import { resolveRoutes } from './routes/resolve';
import { offersRoutes } from './routes/offers';
import { similarRoutes } from './routes/similar';
import { chatRoutes } from './routes/chat';
import { serpSearchRoutes } from './routes/serp-search';
import { diagnosticsRoutes } from './routes/diagnostics';
import { initializeTextEmbeddingService, cleanupTextEmbeddingService, initializeImageEmbeddingService, cleanupImageEmbeddingService } from './embeddings';
import { startBackgroundJobWorker, stopBackgroundJobWorker } from './jobs/mvRefresh';

// Load environment variables
dotenv.config();

const fastify = Fastify({
  logger: true,
  requestIdLogLabel: 'requestId',
  genReqId: () => require('nanoid').nanoid(10),
  bodyLimit: 10485760, // 10MB - Allow larger payloads for base64 images (default is 1MB)
});

// Register plugins
async function registerPlugins() {
  // CORS - Configure allowed origins
  const getAllowedOrigins = () => {
    const baseOrigins = [
      'http://localhost:5173', // Web app dev (changed from 3000)
      'http://localhost:3001', // API dev
      'http://localhost:3002', // Promo site dev
    ];

    // Add extension origins
    const extensionOrigins = [
      // Chrome extensions
      /^chrome-extension:\/\/[a-z]{32}$/,
      // Firefox extensions  
      /^moz-extension:\/\/[a-f0-9-]{36}$/,
    ];

    if (process.env.NODE_ENV === 'production') {
      // Add production domains from environment variable or hardcoded
      const envOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',') || [];
      const productionOrigins = [
        'http://localhost:5173',  // Your Vercel frontend
        ...envOrigins,
      ];
      return [...baseOrigins, ...productionOrigins, ...extensionOrigins];
    }

    return [...baseOrigins, ...extensionOrigins];
  };

  await fastify.register(cors, {
    // origin: (origin, callback) => {
    //   // In development, allow all origins for extension testing
    //   if (process.env.NODE_ENV !== 'production') {
    //     return callback(null, true);
    //   }

    //   const allowedOrigins = getAllowedOrigins();
      
    //   // Allow requests with no origin (mobile apps, curl, etc.)
    //   if (!origin) return callback(null, true);
      
    //   // Check string origins
    //   const stringOrigins = allowedOrigins.filter(o => typeof o === 'string');
    //   if (stringOrigins.includes(origin)) {
    //     return callback(null, true);
    //   }
      
    //   // Check regex origins (for extensions)
    //   const regexOrigins = allowedOrigins.filter(o => o instanceof RegExp);
    //   for (const regex of regexOrigins) {
    //     if (regex.test(origin)) {
    //       return callback(null, true);
    //     }
    //   }
      
    //   // Origin not allowed
    //   callback(new Error('Not allowed by CORS'), false);
    // },
    origin: true,
    credentials: true, // Allow cookies/auth headers
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'), // 1 minute
    errorResponseBuilder: (request, context) => ({
      error: 'Rate limit exceeded',
      message: `Too many requests, retry after ${Math.round(context.ttl / 1000)} seconds`,
    }),
  });
}

// Register routes
async function registerRoutes() {
  await fastify.register(resolveRoutes, { prefix: '/api' });
  await fastify.register(offersRoutes, { prefix: '/api' });
  await fastify.register(similarRoutes, { prefix: '/api' });
  await fastify.register(chatRoutes, { prefix: '/api' });
  await fastify.register(serpSearchRoutes, { prefix: '/api' });
  await fastify.register(diagnosticsRoutes, { prefix: '/api' });
}

// Graceful shutdown
async function gracefulShutdown() {
  logger.info('Shutting down server...');
  try {
    // Stop background job worker
    stopBackgroundJobWorker();
    
    // Cleanup text and image embedding services
    cleanupTextEmbeddingService();
    cleanupImageEmbeddingService();
    
    await fastify.close();
    await closeDatabase();
    logger.info('Server shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Start server
async function start() {
  try {
    // Initialize database with separate read/write pools for better scaling
    // Read pool: larger, for SELECT queries (product lookups, search, etc.)
    // Write pool: smaller, for INSERT/UPDATE/DELETE (scrapers, embeddings, etc.)
    const dbConfig = {
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      database: process.env.DATABASE_NAME || 'find_db',
      user: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      ssl: process.env.DATABASE_SSL === 'true',
    };

    initializeDatabase({
      write: {
        ...dbConfig,
        // Write pool: smaller, longer timeouts (writes can take longer)
        max: parseInt(process.env.DATABASE_WRITE_POOL_SIZE || '5'),
      connectionTimeoutMillis: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT || '10000'),
      idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || '30000'),
      },
      // Read pool config (optional - uses same host, but can point to read replica)
      read: {
        ...dbConfig,
        // Override host if read replica is configured
        host: process.env.DATABASE_READ_HOST || dbConfig.host,
        port: parseInt(process.env.DATABASE_READ_PORT || String(dbConfig.port)),
        // Read pool: larger, shorter timeouts (reads should be fast)
        max: parseInt(process.env.DATABASE_READ_POOL_SIZE || '15'),
        connectionTimeoutMillis: parseInt(process.env.DATABASE_READ_CONNECTION_TIMEOUT || '5000'),
        idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || '30000'),
      },
    });

    // Register plugins and routes
    await registerPlugins();
    await registerRoutes();

    // Initialize text embedding service
    logger.info('Initializing text embedding service...');
    try {
    await initializeTextEmbeddingService();
    } catch (error) {
      logger.warn({ error }, 'Text embedding service initialization failed - will retry on first request');
    }

    // Initialize image embedding service
    logger.info('Initializing image embedding service...');
    try {
    await initializeImageEmbeddingService();
    } catch (error) {
      logger.warn({ error }, 'Image embedding service initialization failed - will retry on first request');
    }

    // Start background job worker
    logger.info('Starting background job worker...');
    startBackgroundJobWorker();

    // Start listening
    const port = parseInt(process.env.PORT || '3001');
    const host = process.env.HOST || '127.0.0.1';
    
    await fastify.listen({ port, host });
    logger.info(`Server listening on http://${host}:${port}`);
    logger.info('Backend server ready with text and image embedding services!');

  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  process.exit(1);
});

// Start the server
if (require.main === module) {
  start();
}

export { fastify };
