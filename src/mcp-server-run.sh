#!/bin/bash
# Startup script for McpServerFunction under the AWS Lambda Web Adapter.
# Zip-package (non-container) deployments point Handler at a script like
# this one instead of a normal file.function handler -- the adapter execs
# it directly (AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap, see template.yaml),
# and it's this script's job to start the actual HTTP server the adapter
# then proxies traffic to. See the Makefile's build-McpServerFunction target
# for how this gets into the deployed zip alongside the esbuild bundle.
exec node mcp-server.js
