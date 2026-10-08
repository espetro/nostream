#!/usr/bin/env bash
# Build the scriptc-compiled native validator CLI (native/src/cli.ts).
#
# Requirements:
#   - scriptc 0.2.5      (npm i -g scriptc)          — TypeScript → native compiler
#   - a clang driver     scriptc shells out to `clang` to emit/link objects.
#     This script synthesizes one on top of `zig cc` when no real clang exists
#     (zig 0.16 via `mise install zig@0.16.0` or any zig on PATH).
#
# Usage: scripts/build-native.sh [output-path]   (default: native/dist/nostream-validate)

set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-native/dist/nostream-validate}"

if ! command -v scriptc >/dev/null 2>&1; then
  echo "scriptc not found; installing scriptc@0.2.5 with npm..." >&2
  npm i -g scriptc@0.2.5
fi

if ! command -v clang >/dev/null 2>&1; then
  ZIG_BIN="$(command -v zig || true)"
  if [ -z "$ZIG_BIN" ] && command -v mise >/dev/null 2>&1; then
    echo "zig not found; installing zig@0.16.0 with mise..." >&2
    mise install zig@0.16.0 >&2
    ZIG_BIN="$(mise which zig 2>/dev/null || true)"
  fi
  if [ -z "$ZIG_BIN" ]; then
    echo "error: no clang and no zig on PATH; install clang, or zig (mise install zig@0.16.0)" >&2
    exit 1
  fi
  # scriptc invokes `clang -target x86_64-unknown-linux-gnu ...`; zig cc rejects
  # the *-unknown-linux-gnu triple, so the shim rewrites it to x86_64-linux-gnu.
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

mkdir -p "$(dirname "$OUT")"
exec scriptc build --dynamic native/src/cli.ts -o "$OUT"
