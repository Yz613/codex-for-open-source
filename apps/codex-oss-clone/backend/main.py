import asyncio
import json
import os
import re
import shlex
import time
import uuid
from typing import AsyncIterator, List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="VibeCode Local CLI Backend")

MODEL_CLI_CMD = shlex.split(os.getenv("MODEL_CLI_CMD", "ollama run qwen2.5:7b"))
MODEL_ID = os.getenv("MODEL_ID", "local-cli-model")
CLI_PROMPT_MODE: Literal["arg", "stdin"] = os.getenv("CLI_PROMPT_MODE", "arg").lower()  # type: ignore[assignment]
MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "120000"))
STREAM_CHUNK_BYTES = int(os.getenv("STREAM_CHUNK_BYTES", "512"))

if CLI_PROMPT_MODE not in {"arg", "stdin"}:
    CLI_PROMPT_MODE = "arg"

ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


class Message(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ChatCompletionsRequest(BaseModel):
    model: Optional[str] = None
    messages: List[Message]
    stream: bool = False
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = Field(default=1024, ge=1, le=32768)


class SimpleChatRequest(BaseModel):
    messages: List[Message]
    stream: bool = False
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = Field(default=1024, ge=1, le=32768)


def build_prompt(messages: List[Message]) -> str:
    parts: List[str] = []
    for msg in messages:
        if msg.role == "system":
            parts.append(f"System:\n{msg.content}")
        elif msg.role == "user":
            parts.append(f"User:\n{msg.content}")
        elif msg.role == "assistant":
            parts.append(f"Assistant:\n{msg.content}")
        elif msg.role == "tool":
            parts.append(f"Tool:\n{msg.content}")

    parts.append("Assistant:")

    prompt = "\n".join(parts).strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[-MAX_PROMPT_CHARS:]
    return prompt


def clean_cli_text(text: str) -> str:
    cleaned = ANSI_ESCAPE_RE.sub("", text)
    cleaned = cleaned.replace("\r", "")
    return cleaned


def chunk_payload(model: str, content: str, finish_reason: Optional[str] = None) -> str:
    payload = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content} if content else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n"


def completion_payload(model: str, content: str) -> dict:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
    }


async def start_cli_process(prompt: str) -> asyncio.subprocess.Process:
    if not MODEL_CLI_CMD:
        raise RuntimeError("MODEL_CLI_CMD is empty")

    cmd = MODEL_CLI_CMD if CLI_PROMPT_MODE == "stdin" else [*MODEL_CLI_CMD, prompt]
    process_env = os.environ.copy()
    process_env["TERM"] = "dumb"
    process_env["NO_COLOR"] = "1"
    process_env["CLICOLOR"] = "0"

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if CLI_PROMPT_MODE == "stdin" else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=process_env,
    )

    if CLI_PROMPT_MODE == "stdin" and process.stdin is not None:
        process.stdin.write(prompt.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()

    return process


async def run_cli(prompt: str) -> tuple[int, str, str]:
    process = await start_cli_process(prompt)
    stdout_bytes, stderr_bytes = await process.communicate()
    stdout = clean_cli_text(stdout_bytes.decode("utf-8", errors="ignore"))
    stderr = clean_cli_text(stderr_bytes.decode("utf-8", errors="ignore"))
    return process.returncode, stdout, stderr


async def stream_cli(prompt: str, model: str) -> AsyncIterator[str]:
    process = await start_cli_process(prompt)
    assert process.stdout is not None

    while True:
        chunk = await process.stdout.read(STREAM_CHUNK_BYTES)
        if not chunk:
            break
        text = clean_cli_text(chunk.decode("utf-8", errors="ignore"))
        if text:
            yield chunk_payload(model=model, content=text)

    stderr_text = ""
    if process.stderr is not None:
        stderr_bytes = await process.stderr.read()
        stderr_text = clean_cli_text(stderr_bytes.decode("utf-8", errors="ignore"))

    await process.wait()

    if process.returncode != 0:
        error_payload = {
            "error": {
                "message": stderr_text.strip() or "CLI runner failed",
                "code": process.returncode,
            }
        }
        yield f"data: {json.dumps(error_payload)}\n\n"
    else:
        yield chunk_payload(model=model, content="", finish_reason="stop")

    yield "data: [DONE]\n\n"


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "model": MODEL_ID, "cli_cmd": MODEL_CLI_CMD}


@app.get("/models")
@app.get("/v1/models")
async def models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "owned_by": "local-cli",
            }
        ],
    }


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionsRequest):
    prompt = build_prompt(req.messages)
    model = req.model or MODEL_ID

    if req.stream:
        return StreamingResponse(
            stream_cli(prompt, model),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    returncode, stdout, stderr = await run_cli(prompt)
    if returncode != 0:
        raise HTTPException(status_code=500, detail=stderr.strip() or "CLI runner failed")

    return JSONResponse(completion_payload(model=model, content=stdout.strip()))


@app.post("/api/chat")
async def chat(req: SimpleChatRequest):
    prompt = build_prompt(req.messages)

    if req.stream:
        return StreamingResponse(
            stream_cli(prompt, MODEL_ID),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    returncode, stdout, stderr = await run_cli(prompt)
    if returncode != 0:
        raise HTTPException(status_code=500, detail=stderr.strip() or "CLI runner failed")

    return {"content": stdout.strip()}
