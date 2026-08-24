# SAM custom build for McpServerFunction (Metadata.BuildMethod: makefile in
# template.yaml). Needed instead of SAM's built-in Node esbuild builder
# because that builder's output is the bundle alone -- it doesn't carry
# along the run.sh startup script the AWS Lambda Web Adapter's zip-package
# convention requires (Handler: run.sh; see src/mcp-server-run.sh and
# https://aws.github.io/aws-lambda-web-adapter/getting-started/zip-packages.html).
# `sam build` invokes `make build-McpServerFunction` with $(ARTIFACTS_DIR)
# set to the staging directory it'll zip up.
build-McpServerFunction:
	npx esbuild src/mcp-server.ts --bundle --platform=node --target=es2022 --format=cjs \
		--outfile="$(ARTIFACTS_DIR)/mcp-server.js"
	cp src/mcp-server-run.sh "$(ARTIFACTS_DIR)/run.sh"
	chmod 755 "$(ARTIFACTS_DIR)/run.sh"
