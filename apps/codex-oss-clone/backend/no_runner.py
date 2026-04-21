#!/usr/bin/env python3
import sys

prompt = sys.argv[-1] if len(sys.argv) > 1 else ""
print(
    "No local model CLI runner is installed on this machine.\n\n"
    "Install one of the following and restart the backend:\n"
    "- ollama (recommended): MODEL_CLI_CMD='ollama run qwen2.5:7b'\n"
    "- qwen-cli\n"
    "- llama-cli\n\n"
    f"Prompt preview: {prompt[:120]}"
)
