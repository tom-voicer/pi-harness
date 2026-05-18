# Examples | Zigflow

> Source: [https://zigflow.dev/docs/examples](https://zigflow.dev/docs/examples)

A curated set of examples that demonstrate common Zigflow patterns.

## Beginner[​](#beginner "Direct link to Beginner")

Example

Description

Key concepts

[Hello World](https://zigflow.dev/docs/examples/hello-world)

Minimal single-task workflow

`set`, `output.as`

[HTTP Call](https://zigflow.dev/docs/examples/http-call)

External HTTP request

`call: http`, retries

## Intermediate[​](#intermediate "Direct link to Intermediate")

Example

Description

Key concepts

[Error Handling](https://zigflow.dev/docs/examples/error-handling)

Catch errors and recover

`try`, `catch`, `raise`

[Parallel Tasks](https://zigflow.dev/docs/examples/parallel-tasks)

Run branches concurrently

`fork`, `compete`

[Signal-Driven Workflow](https://zigflow.dev/docs/examples/signal-driven)

Pause for an external signal

`listen`, `signal`

* * *

## Repository examples[​](#repository-examples "Direct link to Repository examples")

The [examples directory](https://github.com/zigflow/zigflow/tree/main/examples) in the repository contains additional patterns:

*   `basic`: combined set, wait, fork and HTTP in one workflow
*   `for-loop`: iterating over arrays, maps and numbers
*   `child-workflows`: calling one workflow from another
*   `query`: exposing workflow state via Temporal queries
*   `update`: read/write handlers for running workflows
*   `schedule`: scheduled workflow triggers
*   `money-transfer`: compensating transaction logic
*   `external-calls`: HTTP and gRPC in a single fork

* * *

## Related pages[​](#related-pages "Direct link to Related pages")

*   [Quickstart](https://zigflow.dev/docs/getting-started/quickstart): your first workflow
*   [DSL reference](https://zigflow.dev/docs/dsl/intro): full workflow YAML reference
*   [Concepts: overview](https://zigflow.dev/docs/concepts/overview): mental model