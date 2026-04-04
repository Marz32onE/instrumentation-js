.PHONY: install build test lint clean publish-dry

# Install all workspace dependencies
install:
	npm install

# Build publishable packages
build:
	npm run build -w packages/otel-ws -w packages/otel-rxjs-ws

# Run all tests
test:
	npm run test --workspaces

# Type-check (tsc --noEmit) + ESLint (see eslint.config.mjs)
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf packages/*/dist

# Dry-run publish (verify package contents without uploading)
publish-dry:
	cd packages/otel-rxjs-ws && npm pack --dry-run
