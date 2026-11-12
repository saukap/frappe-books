import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const frontendRoot = __dirname;
const appRoot = path.resolve(frontendRoot, '..');
const base = '/assets/frappe_books/books/';

// `pilot dev start` passes its bench and web port to the `dev` script. In a bench's
// apps/ folder, the bench is two folders up.
const benchPath =
  process.env.FRAPPE_BENCH_PATH ?? path.resolve(appRoot, '../..');
const commonSiteConfigPath = path.join(
  benchPath,
  'sites/common_site_config.json'
);
const commonSiteConfig = fs.existsSync(commonSiteConfigPath)
  ? JSON.parse(fs.readFileSync(commonSiteConfigPath, 'utf8'))
  : {};
const siteUrl = new URL(
  process.env.BOOKS_SITE_URL ??
    `http://127.0.0.1:${process.env.FRAPPE_WEB_SERVER_PORT ?? commonSiteConfig.webserver_port ?? 8000}`
);
// Frappe picks the site from this header. The page's host names no site behind the
// dev server, and frappe-ui sends that host in the header.
const siteName = process.env.BOOKS_SITE_URL
  ? siteUrl.hostname
  : (commonSiteConfig.default_site ?? 'localhost');
const siteHeaders = { 'X-Frappe-Site-Name': siteName };

// Frappe renders /books from the built index.html with the session's boot data. Serve
// that page with the dev entry in place of the built bundle.
function booksPage(): Plugin {
  const builtEntry = new RegExp(
    `<script type="module"[^>]*src="${base}assets/[^"]+"[^>]*></script>`
  );
  return {
    name: 'books-page',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (
          req.method !== 'GET' ||
          !/^\/books(\/|\?|$)/.test(url) ||
          !req.headers.accept?.includes('text/html')
        ) {
          return next();
        }
        const headers = {
          ...req.headers,
          ...siteHeaders,
          'accept-encoding': 'identity',
        };
        http
          .get(new URL(url, siteUrl), { headers }, async (page) => {
            try {
              if (
                page.statusCode !== 200 ||
                !page.headers['content-type']?.includes('text/html')
              ) {
                res.writeHead(page.statusCode ?? 502, page.headers);
                page.pipe(res);
                return;
              }
              let html = '';
              for await (const chunk of page) html += chunk;
              // Not transformIndexHtml: it would prefix `base` to Frappe's own script URLs.
              html = html.replace(
                builtEntry,
                `<script type="module" src="${base}@vite/client"></script>` +
                  `<script type="module" src="${base}src/web/main.ts"></script>`
              );
              const pageHeaders = { ...page.headers };
              delete pageHeaders['content-length'];
              res.writeHead(200, pageHeaders);
              res.end(html);
            } catch (error) {
              next(error);
            }
          })
          .on('error', next);
      });
    },
  };
}

export default defineConfig(async () => {
  const { lucideIconsPlugin } =
    await import('frappe-ui/vite/lucideIconsPlugin');

  return {
    base,
    plugins: [lucideIconsPlugin(), vue(), booksPage()],
    resolve: {
      alias: {
        fyo: path.resolve(frontendRoot, 'fyo'),
        src: path.resolve(frontendRoot, 'src'),
        schemas: path.resolve(frontendRoot, 'schemas'),
        models: path.resolve(frontendRoot, 'models'),
        utils: path.resolve(frontendRoot, 'utils'),
        reports: path.resolve(frontendRoot, 'reports'),
        // `frappe-ui/experimental` fails vue-tsc (frappe/frappe-ui#1247).
        'frappe-ui-command-palette': path.resolve(
          frontendRoot,
          'node_modules/frappe-ui/experimental/CommandPalette/index.ts'
        ),
        'frappe-ui-accordion': path.resolve(
          frontendRoot,
          'node_modules/frappe-ui/experimental/Accordion/index.ts'
        ),
      },
    },
    define: {
      'import.meta.env.VITE_ROUTER_BASE': JSON.stringify('/books/'),
    },
    // frappe-ui ships TypeScript source whose `#utils/*` imports esbuild cannot
    // pre-bundle; Vite serves it like the app's own source. Its echarts imports
    // would then load as hundreds of modules, so pre-bundle those.
    optimizeDeps: {
      exclude: ['frappe-ui'],
      include: [
        'frappe-ui > dayjs/esm',
        'frappe-ui > echarts/charts',
        'frappe-ui > echarts/components',
        'frappe-ui > echarts/core',
        'frappe-ui > echarts/features',
        'frappe-ui > echarts/renderers',
      ],
    },
    build: {
      outDir: path.resolve(appRoot, 'frappe_books/public/books'),
      emptyOutDir: true,
      target: 'es2020',
      sourcemap: false,
    },
    server: {
      port: 6969,
      // Hosts such as Amp orb portals set this for Vite 6, which reads it itself.
      allowedHosts:
        process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS?.split(','),
      // Everything outside the dev server's own base goes to the site.
      proxy: {
        [`^/(?!${base.slice(1)})`]: {
          target: siteUrl.origin,
          headers: siteHeaders,
        },
      },
    },
  };
});
