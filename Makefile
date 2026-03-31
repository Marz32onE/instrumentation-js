.PHONY: install build test lint clean publish-dry

# Install all workspace dependencies
install:
	npm install

# Build all packages (otel-ws-message must build first as it is a shared dep)
build:
	npm run build -w packages/otel-ws-message
	npm run build -w packages/otel-ws -w packages/otel-rxjs-ws

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
	cd packages/otel-rxjs-ws && npm pack --dry-run
