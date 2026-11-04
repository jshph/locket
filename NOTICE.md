# Notices and attribution

index-agent is licensed under the GNU General Public License v3.0 (see `LICENSE`).

## Code and text included or adapted

- **Pebble Index 01 agent and Todoist plugin**, from
  [coredevices/mobileapp](https://github.com/coredevices/mobileapp), licensed **GPL-3.0**.
  Copies of the relevant sources are kept unmodified for reference in `reference/upstream/`
  (`agent@dbc937e`, `todoist-plugin@531b6c9`). The router's rules and prompt (`src/router.ts`),
  the calendar trigger guard, and the Todoist task logic (`src/actions.ts`) are adapted from them.
- **Margins connected-note skill**, from [byenzyme/margins](https://github.com/byenzyme/margins),
  licensed **Apache-2.0**. `reference/margins-skill/` is a copy of `skills/margins/` at commit
  `5c090e9c3a7b`. The distiller (`src/distill.ts`) sends its `distillation-core.md` and
  `templates/` to the model unchanged and adapts its workflow for unattended use. Apache-2.0
  material may be combined into a GPL-3.0 work; its license terms continue to apply to those files.

## Protocols

- **Omi** ([BasedHardware/omi](https://github.com/BasedHardware/omi), MIT): the Custom STT
  WebSocket protocol and the "Conversation created" webhook payload are implemented from Omi's
  public documentation and source. No Omi code is included.

## Dependencies and models (downloaded, not redistributed)

| Component | Used for | License |
|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | speech inference runtime | Apache-2.0 |
| [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (sherpa-onnx int8 export) | transcription | CC-BY-4.0 |
| [Silero VAD](https://github.com/snakers4/silero-vad) | voice activity detection | MIT |
| [pyannote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0) | speaker segmentation | MIT |
| [WeSpeaker](https://github.com/wenet-e2e/wespeaker) ResNet34-LM trained on VoxCeleb | speaker voiceprints | code Apache-2.0; model follows VoxCeleb, CC-BY-4.0 |

The models are fetched by `scripts/download-models.sh` from the sherpa-onnx releases. CC-BY-4.0
requires attribution if you redistribute them; this notice provides it for the project.
