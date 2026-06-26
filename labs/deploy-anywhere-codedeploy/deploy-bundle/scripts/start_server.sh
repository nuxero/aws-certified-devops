#!/bin/bash
# Restart nginx so it serves the newly deployed content
echo "[ApplicationStart] Restarting nginx..."
systemctl restart nginx
echo "[ApplicationStart] nginx restarted at $(date)"