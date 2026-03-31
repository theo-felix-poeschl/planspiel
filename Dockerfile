FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
# install build dependencies needed for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ sqlite-dev
RUN npm ci --only=production
# optionally remove build dependencies to keep image small
RUN apk del python3 make g++ || true
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
