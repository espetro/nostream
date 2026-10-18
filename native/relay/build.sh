#!/usr/bin/env bash
# Build the scriptc-compiled native relay (native/relay/src/main.ts) into a
# single ELF: vendored chttp sources (program code) + @cutils/sqlite via
# --npm-static and the package's ffi.json manifest (embedded libsqlite3).
#
# Requirements: pnpm install (for @chttp/* + @cutils/sqlite in node_modules),
# scriptc >= 0.3.4, and a clang driver — same zig-cc shim pattern as
# scripts/build-native.sh.
#
# Usage: native/relay/build.sh [output-path] (default: native/relay/dist/nostream-native)
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT="${1:-native/relay/dist/nostream-native}"

if ! command -v scriptc >/dev/null 2>&1; then
  echo "scriptc not found; install scriptc>=0.3.4 (npm i -g scriptc)" >&2
  exit 1
fi

if ! command -v clang >/dev/null 2>&1; then
  ZIG_BIN="$(command -v zig || true)"
  if [ -z "$ZIG_BIN" ] && command -v mise >/dev/null 2>&1; then
    mise install zig@0.16.0 >&2 || true
    ZIG_BIN="$(mise which zig 2>/dev/null || true)"
  fi
  if [ -z "$ZIG_BIN" ]; then
    echo "error: no clang and no zig on PATH" >&2
    exit 1
  fi
  SHIM_DIR="$(pwd)/.scriptc-toolchain/bin"
  mkdir -p "$SHIM_DIR"
  cat > "$SHIM_DIR/clang" <<EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  case "\$a" in
    x86_64-unknown-linux-gnu)          args+=("x86_64-linux-gnu") ;;
    -target=x86_64-unknown-linux-gnu)  args+=("-target=x86_64-linux-gnu") ;;
    *)                        args+=("\$a") ;;
  esac
done
exec "$ZIG_BIN" cc "\${args[@]}"
EOF
  chmod +x "$SHIM_DIR/clang"
  export PATH="$SHIM_DIR:$PATH"
  echo "using zig-cc clang shim at $SHIM_DIR/clang ($ZIG_BIN)" >&2
fi

SQLITE="node_modules/@cutils/sqlite"
if [ ! -f "$SQLITE/ffi.json" ] || [ ! -f "$SQLITE/elf/shims.d.ts" ]; then
  echo "error: $SQLITE lacks ffi.json/elf — need @cutils/sqlite with the ./elf" >&2
  echo "       entry (post-0.3.0 git, or a pack from sigilco/cutils)" >&2
  exit 1
fi

node native/relay/vendor.mjs

mkdir -p "$(dirname "$OUT")"
exec scriptc build native/relay/src/main.ts \
  --ffi "$SQLITE/ffi.json" \
  --ffi "$SQLITE/ffi.json" \
  -o "$OUT"
