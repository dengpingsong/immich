#!/bin/sh
# Entrypoint for the Ascend NPU machine-learning image.
#
# The CANN toolkit is mounted from the host, so its environment (library paths, op packages, Python
# modules) has to be sourced before the service starts; otherwise the CANN execution provider fails
# during graph build. The toolkit location is overridable so a different CANN install can be mounted.
set -eu

CANN_ROOT="${ASCEND_HOME_PATH:-/usr/local/Ascend/cann-9.0.0}"

if [ -f "$CANN_ROOT/set_env.sh" ]; then
  # shellcheck disable=SC1090
  . "$CANN_ROOT/set_env.sh" >/dev/null 2>&1 || true
fi

# Writable scratch: the mounted toolkit is read-only, so compiled kernels and caches go to /cache.
mkdir -p "${ASCEND_WORK_PATH:-/cache/ascend-work}" "${ASCEND_CACHE_PATH:-/cache/ascend-cache}"

exec "$@"
