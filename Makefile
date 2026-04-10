.PHONY: install build test test-integration lint clean publish-dry

# Install all workspace dependencies
install:
	npm install

# Build publishable packages
build:
	npm run build -w packages/otel-ws -w packages/otel-rxjs-ws -w packages/otel-nats

# Run all tests
test:
	npm run test --workspaces

# Run integration tests for otel-nats (requires Docker)
test-integration:
	npm run test:integration -w packages/otel-nats

# Type-check (tsc --noEmit per workspace) + ESLint (see eslint.config.mjs)
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf packages/*/dist

# Dry-run publish (verify package contents without uploading)
publish-dry:
	cd packages/otel-rxjs-ws && npm pack --dry-run
