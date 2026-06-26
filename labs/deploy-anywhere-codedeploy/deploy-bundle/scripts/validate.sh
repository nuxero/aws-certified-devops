#!/bin/bash
echo "[ValidateService] Checking nginx health..."
systemctl is-active nginx || exit 1
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost)
if [ "$HTTP_CODE" != "200" ]; then
  echo "[ValidateService] FAILED — HTTP $HTTP_CODE"
  exit 1
fi
echo "[ValidateService] SUCCESS"