#!/bin/bash
# Startup script for McpServerFunction under the AWS Lambda Web Adapter. A
# zip-package deployment points Handler at a script like this instead of a
# file.function handler: the adapter execs it directly
# (AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap), and its job is to start the HTTP
# server the adapter proxies to. The Makefile puts it in the zip.
exec node mcp-server.js
