import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL || 'http://localhost:3001/api'),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        styles: resolve(__dirname, 'src/index.css'),
      },
      output: {
        entryFileNames: (chunk) => `${chunk.name}.js`,
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'index.css' || assetInfo.name === 'styles.css') {
            return 'ui.css'; // Ensure CSS is named ui.css
          }
          return 'assets/[name].[ext]';
        },
        format: 'es',
        manualChunks: undefined,
      },
    },
  },
  plugins: [
    react(),
    {
      name: 'build-content-script',
      async closeBundle() {
        // Build content script as IIFE separately
        const { build } = await import('vite');
        await build({
          configFile: false,
          define: {
            'process.env.NODE_ENV': '"production"',
            'process.env': '{}',
            'global': 'globalThis',
          },
          mode: 'production',
          build: {
            outDir: resolve(__dirname, 'dist'),
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, 'src/content.ts'),
              name: 'ContentScript',
              fileName: () => 'content.js',
              formats: ['iife'],
            },
            rollupOptions: {
              output: {
                extend: true,
                inlineDynamicImports: true,
              },
            },
          },
          resolve: {
            alias: {
              '@': resolve(__dirname, 'src'),
            },
          },
        });
      },
    },
    {
      name: 'copy-files-and-build-css',
      closeBundle() {
        mkdirSync(resolve(__dirname, 'dist'), { recursive: true });
        
        // ADD: Copy icons folder
        mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true });
        copyFileSync(
          resolve(__dirname, 'icons/icon16.png'),
          resolve(__dirname, 'dist/icons/icon16.png')
        );
        copyFileSync(
          resolve(__dirname, 'icons/icon32.png'),
          resolve(__dirname, 'dist/icons/icon32.png')
        );
        copyFileSync(
          resolve(__dirname, 'icons/icon48.png'),
          resolve(__dirname, 'dist/icons/icon48.png')
        );
        copyFileSync(
          resolve(__dirname, 'icons/icon128.png'),
          resolve(__dirname, 'dist/icons/icon128.png')
        );
        
        copyFileSync(
          resolve(__dirname, 'manifest.json'),
          resolve(__dirname, 'dist/manifest.json')
        );
        // extension.html not needed - using shadow DOM injection
        
        // Generate CSS bundle for shadow DOM injection
        try {
          // Try multiple possible CSS file locations
          let cssContent = '';
          const possiblePaths = [
            resolve(__dirname, 'dist/ui.css'),
            resolve(__dirname, 'dist/assets/styles.css'),
            resolve(__dirname, 'dist/style.css'),
            resolve(__dirname, 'dist/assets/index.css')
          ];
          
          for (const cssPath of possiblePaths) {
            try {
              cssContent = readFileSync(cssPath, 'utf-8');
              console.log(`Found CSS at: ${cssPath}`);
              break;
            } catch (e) {
              // Continue to next path
            }
          }
          
          if (cssContent) {
            // Ensure ui.css exists for web_accessible_resources
            writeFileSync(resolve(__dirname, 'dist/ui.css'), cssContent);
            
            // Also generate JS export for fallback
            const cssJs = `export const extensionCSS = \`${cssContent.replace(/`/g, '\\`')}\`;`;
            writeFileSync(resolve(__dirname, 'dist/extension-styles.js'), cssJs);
            
            console.log('✅ CSS bundle generated successfully');
          } else {
            console.warn('⚠️ No CSS file found in any expected location');
          }
        } catch (error) {
          console.warn('Could not generate CSS bundle:', error);
        }
      },
    },
  ],
});
