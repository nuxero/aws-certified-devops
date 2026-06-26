#!/bin/bash
# Remove the old index.html so the Install phase has a clean target
echo "[BeforeInstall] Cleaning up old deployment..."
rm -f /usr/share/nginx/html/index.html
echo "[BeforeInstall] Done at $(date)"