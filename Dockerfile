# Pin this to the exact version of the `playwright` npm package (see
# package.json) so the Chromium build baked into the image always matches
# the Playwright client library used by the server.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production

# Railway injects PORT at runtime; the app reads it via process.env.PORT.
EXPOSE 8080

CMD ["npm", "start"]
