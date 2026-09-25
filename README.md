# ama-rag-workshop

Build a RAG pipeline step by step and open every intermediate result: load → clean → chunk → embed →
store → retrieve → rerank → answer → evaluate. Everything runs on your laptop: local models through
[Ollama](https://ollama.com), the vector database (Chroma) in a Podman container, TypeScript only.

The documents are the policy handbook of **Kraken Air**, a fictional company — two editions (2025, 2026),
one English document, one HR-only document, and one announcement with an instruction planted inside it.

The course pages that walk through this repo: see the link in the repo description.

## Install (once, before the day)

| What | Check |
|---|---|
| [Node.js 22+](https://nodejs.org) | `node -v` |
| [git](https://git-scm.com) | `git --version` |
| [Ollama](https://ollama.com/download) + two models | `ollama pull gemma3:4b` · `ollama pull bge-m3` |
| [Podman Desktop](https://podman-desktop.io) (or Docker) | `podman pull docker.io/chromadb/chroma:1.5.9` |
| [Bruno](https://www.usebruno.com) (optional, to look inside) | open the `bruno/` folder as a collection |

```sh
git clone https://github.com/kuthaygumus/ama-rag-workshop.git   # not inside OneDrive
cd ama-rag-workshop
npm ci
podman compose up -d        # Chroma on http://localhost:8000
npm run doctor              # checks Node, Ollama, both models, Chroma — and times one answer
```

No Podman? Put `STORE=json` in a `.env` file (copy `env.example`): the vectors then live in
`data/store.json` and everything else works the same.

## The day

Each step runs on its own, reads the previous step's file in `data/` and writes its own — open them.

| Command | Step | Writes |
|---|---|---|
| `npm run step -- 0` | ask the model with no documents | — |
| `npm run step -- 1` | load `corpus/2025/`, front matter → metadata | `data/1-docs.json` |
| `npm run step -- 2` | clean: drop page headers/footers, re-join broken lines | `data/2-clean.json` |
| `npm run step -- 3` | chunk: by section (default) or every 300 characters | `data/3-chunks.json` |
| `npm run step -- 4` | embed every chunk with `bge-m3` (1024 numbers each) | `data/4-vectors.json` |
| `npm run similar` / `npm run map` | what did the embedding model decide? | `data/map.html` |
| `npm run step -- 5` | store in Chroma (`--store json` for the JSON file) | `data/5-store.json` |
| `npm run step -- 6` | retrieve the closest chunks, with metadata filters | `data/6-retrieved.json` |
| `npm run step -- 7` | rerank them with the chat model | `data/7-reranked.json` |
| `npm run step -- 8` | answer from the top chunks (`--prompt` shows the prompt) | `data/8-answer.json` |

Shortcuts: `npm run ingest` (steps 1–5), `npm run ask -- "question"` (steps 6–8),
`npm run question` (the day's question through whatever works right now, plus the ledger of its answers),
`npm run eval` (hit@1 / recall@k / MRR over `eval/gold.jsonl`; `--answers` also checks the answers).

**Toggles** — lines marked `// default` and `// alternative` inside a `// TOGGLE` block: swap which one is
commented, re-run the step, compare. **YOUR TURN** — a function left for you to write below a similar one;
check with `npm run check:sibling`. Finished versions are in `solutions/`.

**Fell behind?** `npm run catchup -- 5` puts every toggle back to its default, empties `data/` and runs steps
1–5 — your own code stays as it is. `npm run catchup -- 0` goes back to the start of the day: nothing
built, so `npm run question` asks the bare model again.

## Settings

Flags or a `.env` file (see `env.example`) — never `VAR=x npm run …`, which does not work on Windows.
`--store chroma|json`, `--edition 2025|2026`, `--k 5`, `OLLAMA_URL`, `CHROMA_URL`, `CHAT_MODEL`, `EMBED_MODEL`.

## For maintainers

`npm run typecheck` · `npm test` (includes `check:legacy`) · `SOLUTIONS=1 npm run check:sibling` ·
`npm run capture` records every output of the day into `logs/` for the course site.
