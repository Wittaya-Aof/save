FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Customs Vessel Arrival lookup uses the same bounded browser adapter as local scanning.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*

# Explicit source inputs only; never copy environment or runtime files.
COPY api-server.js odoo-queries.js manage-users.mjs ./
COPY import-export-os.html freight-comparison.html container-loading-calculator.html ./
COPY login.html ./
COPY lib/ ./lib/
COPY tools/ ./tools/
COPY vendor/ ./vendor/
COPY rds-ca.pem ./rds-ca.pem
COPY docker-entrypoint.sh /usr/local/bin/import-export-entrypoint
RUN chmod 755 /usr/local/bin/import-export-entrypoint && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/import-export-entrypoint"]
CMD ["node", "api-server.js"]
