# Frostwave

Frostwave is an original music-making playground with a local, self-hosted AI video generator. The video page offers five model choices: Wan 2.1 (1.3B and 14B), Wan 2.2 (A14B), and CogVideoX (2B and 5B). It assembles model-generated shots into an MP4 trimmed to five minutes.

## Run the local generator

The renderer needs a supported NVIDIA GPU, CUDA-enabled PyTorch, internet access for the first model download, and free disk space. Wan 2.1 1.3B is the smallest Wan option and needs about 8.2 GB of VRAM; CogVideoX 2B can use sequential CPU offload but will be slower. Larger models need substantially more GPU memory.

1. Install a PyTorch build that matches your CUDA setup using the selector at [pytorch.org](https://pytorch.org/get-started/locally/).
2. Install the remaining Python packages and start the app:

   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   python server.py
   ```

3. Open `http://127.0.0.1:8000`, choose a generator, describe your video, and create it. The selected model's weights download on first use and are cached by Hugging Face.

The local server binds to loopback only. Generated MP4 files are stored in `~/.frostwave/videos` by default; set `FROSTWAVE_DATA_DIR` to use another local folder. `FROSTWAVE_PORT` changes the default port.

## Limits and expectations

- There are no app-imposed generation quotas, paid tiers, or API fees. Jobs run one at a time on the local GPU; the queue has no generation-count cap. Actual throughput and storage are limited by the computer's GPU, power, and disk.
- A five-minute result is made from many short generated shots and trimmed to exactly 300 seconds. Model continuity between independently generated shots can vary.
- Five minutes of video is expensive to render locally: Wan 2.1 1.3B is documented at roughly four minutes per five-second clip on an RTX 4090, so a five-minute result can take several hours, plus assembly time.
- Audio generation and community audio playback are not connected. Video rendering currently produces a silent MP4.
- Wallet connection reads the active address from an injected EVM wallet. It does not sign a message or verify identity with a server, and signing out only disconnects the app's local session.

## Tests

Run the backend validation tests with `python3 -m unittest discover -s tests`.
