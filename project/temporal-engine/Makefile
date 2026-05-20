# Temporal Engine — Dynamic Workflow Executor

.PHONY: up down worker test install clean

# ─── Temporal Server (Docker) ──────────────────────────────

up:
	docker compose up -d
	@echo "✅ Temporal: localhost:7233 | UI: http://localhost:8080"

down:
	docker compose down -v

# ─── Engine ────────────────────────────────────────────────

install:
	cd engine && npm install

worker:
	cd engine && npx ts-node src/worker.ts

worker-nodes:
	cd engine && npx ts-node src/worker-with-nodes.ts

test:
	cd engine && npx ts-node ../test/smoke.ts

run:
	cd engine && npx ts-node src/cli-run.ts $(WF)

test-sub-inline:
	cd engine && npx ts-node src/cli-run.ts ../test/sub-workflow-inline.json

test-sub-file:
	cd engine && npx ts-node src/cli-run.ts ../test/sub-workflow-from-file.json

build:
	cd engine && npx tsc

clean:
	docker compose down -v
	rm -rf engine/node_modules engine/dist
