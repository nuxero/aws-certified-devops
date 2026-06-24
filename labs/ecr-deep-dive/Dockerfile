FROM public.ecr.aws/docker/library/node:18 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

# Stage 2: Production image — slim base with only runtime dependencies
# node:18-slim still carries OS-level CVEs that ECR basic scanning will detect
FROM public.ecr.aws/docker/library/node:18-slim

WORKDIR /app
# Copy only production node_modules from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY app.js ./

EXPOSE 3000

# Health check so ECS/EKS can monitor container health
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "app.js"]