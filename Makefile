# SAM custom build for McpServerFunction (Metadata.BuildMethod: makefile).
# SAM's built-in esbuild builder emits the bundle alone, without the run.sh
# startup script the Lambda Web Adapter's zip-package convention requires
# (Handler: run.sh -- see src/mcp-server-run.sh and
# https://aws.github.io/aws-lambda-web-adapter/getting-started/zip-packages.html).
# `sam build` calls this with $(ARTIFACTS_DIR) set to the staging directory.
build-McpServerFunction:
	npx esbuild src/mcp-server.ts --bundle --platform=node --target=es2022 --format=cjs \
		--outfile="$(ARTIFACTS_DIR)/mcp-server.js"
	cp src/mcp-server-run.sh "$(ARTIFACTS_DIR)/run.sh"
	chmod 755 "$(ARTIFACTS_DIR)/run.sh"
