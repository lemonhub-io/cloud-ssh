#!/usr/bin/env bash
# 构建跨平台单文件可执行 Agent（Node SEA）。
# 流程：esbuild 全量 CJS 打包 → sea blob → 注入各平台官方 node 二进制。
# 用法：agent/scripts/build-sea.sh [目标列表]，缺省构建全部目标。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VER="${SEA_NODE_VERSION:-v22.23.2}"
DIST_BASE="https://nodejs.org/dist/${NODE_VER}"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
OUT_DIR="dist/sea"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUT_DIR"

echo "==> bundling agent (cjs, full inline)"
pnpm exec esbuild src/cli.ts --bundle --format=cjs --platform=node \
  --target=node20 --outfile=dist/sea-entry.cjs --log-level=warning

echo "==> generating sea blob"
node --experimental-sea-config sea-config.json

# 目标定义：<out-name>|<node-dist-archive>|<bin-in-archive>|<extra postject args>
TARGETS=(
  "cloudssh-agent-linux-x64|node-${NODE_VER}-linux-x64.tar.xz|bin/node|"
  "cloudssh-agent-linux-arm64|node-${NODE_VER}-linux-arm64.tar.xz|bin/node|"
  "cloudssh-agent-darwin-x64|node-${NODE_VER}-darwin-x64.tar.gz|bin/node|--macho-segment-name NODE_SEA"
  "cloudssh-agent-darwin-arm64|node-${NODE_VER}-darwin-arm64.tar.gz|bin/node|--macho-segment-name NODE_SEA"
  "cloudssh-agent-windows-x64.exe|node-${NODE_VER}-win-x64.zip|node.exe|"
)

want="${*:-all}"
for spec in "${TARGETS[@]}"; do
  IFS='|' read -r out archive bin extra <<<"$spec"
  if [ "$want" != "all" ]; then
    skip=1
    for t in $want; do [ "$t" = "$out" ] && skip=0; done
    [ "$skip" = 1 ] && continue
  fi
  echo "==> $out  ($archive)"
  pkg_file="$WORK_DIR/$archive"
  curl -fsSL "$DIST_BASE/$archive" -o "$pkg_file"
  dest="$WORK_DIR/extract-$out"
  mkdir -p "$dest"
  case "$archive" in
    *.zip) unzip -q "$pkg_file" -d "$dest" ;;
    *) tar -xf "$pkg_file" -C "$dest" ;;
  esac
  node_bin="$(find "$dest" -name "$(basename "$bin")" -type f | head -1)"
  [ -n "$node_bin" ] || { echo "    node binary not found in $archive" >&2; exit 1; }
  cp "$node_bin" "$OUT_DIR/$out"
  # shellcheck disable=SC2086
  pnpm exec postject "$OUT_DIR/$out" NODE_SEA_BLOB dist/sea.blob \
    --sentinel-fuse "$FUSE" $extra
  chmod +x "$OUT_DIR/$out" 2>/dev/null || true
  echo "    wrote $OUT_DIR/$out ($(du -h "$OUT_DIR/$out" | cut -f1))"
done

echo "==> smoke check linux-x64 binary"
out="$OUT_DIR/cloudssh-agent-linux-x64"
if [ -f "$out" ]; then
  # 先捕获输出再 grep：pipefail 下 grep -q 提前退出会让被测进程吃 SIGPIPE
  smoke_out="$("$out" 2>&1 || true)"
  smoke_ver="$("$out" --version 2>&1 || true)"
  if echo "$smoke_out" | grep -q 'Missing agent token' \
    && echo "$smoke_ver" | grep -q 'cloudssh-agent'; then
    echo "    smoke check ok ($smoke_ver)"
  else
    echo "    smoke check FAILED:" >&2
    echo "$smoke_out" >&2
    echo "$smoke_ver" >&2
    exit 1
  fi
fi
echo "==> done"
