.PHONY: install build test lint clean publish-dry

# Install all workspace dependencies
install:
	npm install

# Build all packages
build:
	npm run build --workspaces

# Run all tests
test:
	npm run test --workspaces

# Type-check without emitting (lint)
lint:
	npm run lint --workspaces

# Remove build artifacts
clean:
	rm -rf packages/*/dist

# Dry-run publish (verify package contents without uploading)
publish-dry:
	cd packages/otel-websocket && npm pack --dry-run
