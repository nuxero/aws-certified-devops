#!/bin/bash
# Replace the timestamp placeholder with the actual deployment time
echo "[AfterInstall] Configuring deployed files..."
sed -i "s/DEPLOY_TIMESTAMP/$(date)/" /usr/share/nginx/html/index.html
echo "[AfterInstall] Done at $(date)"