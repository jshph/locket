#!/usr/bin/env bash
# Downloads the speech models into asr/models (about 660 MB). Sources and licenses: NOTICE.md.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/asr/models"
mkdir -p "$dir"
cd "$dir"
base=https://github.com/k2-fsa/sherpa-onnx/releases/download
fetch() { [ -e "$2" ] || { echo "downloading $1"; curl -fSL --progress-bar -o "$(basename "$1")" "$base/$1"; }; }
fetch asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
fetch asr-models/silero_vad.onnx silero_vad.onnx
fetch speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 sherpa-onnx-pyannote-segmentation-3-0
fetch speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx wespeaker_en_voxceleb_resnet34_LM.onnx  # sic: upstream tag
for t in *.tar.bz2; do [ -e "$t" ] && tar xjf "$t" && rm "$t"; done
echo "models ready in $dir"
