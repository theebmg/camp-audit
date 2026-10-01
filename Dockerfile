FROM node:22-alpine

# Fonts, for the captions sharp stamps onto report photos. Alpine ships none, and without one
# librsvg renders every character as a tofu box — the caption band drew correctly and the text
# was unreadable. fontconfig is what sharp's SVG layer asks for the font through.
RUN apk add --no-cache font-dejavu fontconfig && fc-cache -f

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public-pg ./public-pg
COPY migrations ./migrations
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
