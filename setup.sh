#!/bin/bash
# Bootstrap MusicHammer from source on a fresh Linux machine.
#
#   ./setup.sh cpu    # laptop / no NVIDIA GPU (forces CPU torch, ~1 GB)
#   ./setup.sh cuda   # machine with NVIDIA GPU (default torch wheels, ~4 GB)
#
# Needs: python3 (>=3.10) + venv module, ffmpeg/ffprobe, curl, ~6 GB disk.
# Model checkpoints are NOT fetched here — the app downloads them on first
# use (Models panel), hash-verified, from the original HF repos.
set -e
cd "$(dirname "$0")"
MODE=${1:-cpu}
[ "$MODE" = cpu ] || [ "$MODE" = cuda ] || { echo "usage: ./setup.sh [cpu|cuda]"; exit 1; }

command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not found (install it first)"; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 not found"; exit 1; }
command -v git >/dev/null || { echo "ERROR: git not found (madmom installs from a git pin)"; exit 1; }

echo "== python env (.venv-sidecar, mode: $MODE) =="
[ -d .venv-sidecar ] || python3 -m venv .venv-sidecar
PIP=.venv-sidecar/bin/pip
$PIP install --upgrade pip -q
if [ "$MODE" = cpu ]; then
  # install CPU torch FIRST, otherwise audio-separator drags in ~4 GB of CUDA libs
  $PIP install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
else
  # Default PyPI torch bundles the newest CUDA runtime (13.0 as of torch 2.13),
  # which needs NVIDIA driver >= 580. Older-but-fine drivers (e.g. 550 on
  # Ubuntu 22.04) then get cuda.is_available()=False and a silent CPU fallback.
  # So pick the wheel flavor from the driver that is actually installed:
  # any CUDA 12.x wheel runs on driver >= 525 (12.x minor-version compat).
  command -v nvidia-smi >/dev/null || {
    echo "ERROR: cuda mode, but nvidia-smi not found — install the NVIDIA driver"
    echo "       first, or run ./setup.sh cpu"; exit 1; }
  DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1)
  DRIVER_MAJOR=${DRIVER%%.*}
  if ! [ "$DRIVER_MAJOR" -gt 0 ] 2>/dev/null; then
    echo "ERROR: could not read the NVIDIA driver version from nvidia-smi"; exit 1
  elif [ "$DRIVER_MAJOR" -ge 580 ]; then
    echo "== NVIDIA driver $DRIVER: default torch (CUDA 13) =="
    $PIP install torch torchaudio
  elif [ "$DRIVER_MAJOR" -ge 525 ]; then
    echo "== NVIDIA driver $DRIVER (< 580): torch cu128 wheels =="
    $PIP install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  else
    echo "ERROR: NVIDIA driver $DRIVER is too old for current torch CUDA wheels"
    echo "       (needs >= 525). Upgrade the driver, or run ./setup.sh cpu"; exit 1
  fi
fi
# The [cpu] extra matters: audio-separator's base wheel ships WITHOUT
# onnxruntime but imports it unconditionally, so the CLI crashes at startup
# (ModuleNotFoundError) without it. The CPU build is enough even in cuda mode:
# all our registry models run through audio-separator's torch path, never its
# ONNX path — and onnxruntime-gpu would add its own CUDA/cuDNN version pains.
$PIP install "audio-separator[cpu]==0.44.2" "bs-roformer-infer==0.1.1" \
             "melband-roformer-infer==0.1.1" packaging soundfile -r sidecar/requirements.txt
.venv-sidecar/bin/python sidecar/patches/apply_melband_patch.py

echo "== node + electron (.tools/node, node_modules) =="
NODE_VER=v22.17.0
if [ ! -x .tools/node/bin/node ]; then
  mkdir -p .tools
  curl -sL -o .tools/node.tar.xz "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  tar xf .tools/node.tar.xz -C .tools
  rm .tools/node.tar.xz
  mv ".tools/node-${NODE_VER}-linux-x64" .tools/node
fi
export PATH="$PWD/.tools/node/bin:$PATH"
npm install

echo
echo "Setup complete. Launch with:  ./dev.sh"
echo "First use: open the Models panel and download the model(s) you want."
