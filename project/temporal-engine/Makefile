# Temporal Engine — YAML DSL → Running Workflow
# Powered by Zigflow (zigflow.dev) + Temporal

.PHONY: up down worker submit clean demo

# ─── Temporal Server (Docker) ──────────────────────────────

up:
	docker compose up -d
	@echo "✅ Temporal: localhost:7233 | UI: http://localhost:8080"

down:
	docker compose down -v

# ─── Zigflow Worker ────────────────────────────────────────

worker:
	zigflow run \
		--health-listen-address 0.0.0.0:3001 \
		--metrics-listen-address 0.0.0.0:9091 \
		-f workflows/hello.yaml \
		-f workflows/if-else.yaml \
		-f workflows/for-loop.yaml \
		-f workflows/parallel.yaml \
		-f workflows/repeat.yaml \
		-f workflows/full-demo.yaml

validate:
	@for f in workflows/*.yaml; do \
		zigflow validate "$$f"; \
	done

# ─── Trigger Workflows ─────────────────────────────────────

start-if-else:
	temporal workflow start --type if-else-demo --task-queue zigflow --workflow-id if-else-$$(date +%s)
	temporal workflow result --workflow-id if-else-$$(date +%s) 2>/dev/null || true

start-for-loop:
	temporal workflow start --type for-loop-demo --task-queue zigflow --workflow-id for-loop-$$(date +%s)

start-parallel:
	temporal workflow start --type parallel-demo --task-queue zigflow --workflow-id parallel-$$(date +%s)

start-full:
	temporal workflow start --type full-demo --task-queue zigflow --workflow-id full-$$(date +%s)

# ─── Demo ──────────────────────────────────────────────────

demo:
	@echo "1. Start Temporal:  make up"
	@echo "2. Start worker:    make worker"
	@echo "3. Trigger:"
	@echo "   make start-if-else    # if/else with switch"
	@echo "   make start-for-loop   # for loop with if branching"
	@echo "   make start-parallel   # fork (concurrent)"
	@echo "   make start-full       # all constructs combined"
	@echo ""
	@echo "   or use the Temporal CLI directly:"
	@echo "   temporal workflow start --type <type> --task-queue zigflow --workflow-id <id>"

clean:
	docker compose down -v
	rm -rf zigflow/node_modules zigflow/dist
