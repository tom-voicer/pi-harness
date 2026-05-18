# Signal-Driven Workflow | Zigflow

> Source: [https://zigflow.dev/docs/examples/signal-driven](https://zigflow.dev/docs/examples/signal-driven)

Pause a workflow and wait for an external signal before continuing.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to pause a workflow and wait for a Temporal signal using `listen`
*   How to access signal payload in subsequent tasks
*   How to configure a wait timeout to avoid indefinite blocking

## Workflow[​](#workflow "Direct link to Workflow")

workflow.yaml

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: signal  version: 0.0.1do:  - approveListener:      metadata:        timeout: 10s      listen:        to:          one:            with:              id: approve              type: signal  - outputSignal:      export:        as: '${ $context + { response: . } }'      set:        signal: ${ $data.approveListener }  - wait:      output:        as: ${ $context }      wait:        seconds: 5
```

## Explanation[​](#explanation "Direct link to Explanation")

Part

Purpose

`listen.to.one`

Wait for exactly one matching event

`id: approve`

The Temporal signal name to listen for

`type: signal`

Write-only, fire-and-forget from the sender

`metadata.timeout`

How long to wait before timing out (default 60s)

`$data.approveListener`

Signal payload, accessed by task name

## How to run[​](#how-to-run "Direct link to How to run")

1.  Start a Temporal development server:
    
    ```
    temporal server start-dev
    ```
    
2.  Start the worker:
    
    ```
    zigflow run -f workflow.yaml
    ```
    
3.  Start a workflow execution:
    
    ```
    temporal workflow start \  --type signal \  --task-queue zigflow \  --workflow-id approval-1
    ```
    
4.  Send the signal from a separate terminal:
    
    ```
    temporal workflow signal \  --workflow-id approval-1 \  --name approve \  --input '{"approved": true}'
    ```
    
5.  View the result:
    
    ```
    temporal workflow show --workflow-id approval-1
    ```
    

## Expected behaviour[​](#expected-behaviour "Direct link to Expected behaviour")

After you send the signal, the workflow reads the payload from `$data.approveListener`, stores it under `signal` and then waits 5 seconds before completing.

If no signal arrives within the timeout period, the listen task times out.

## Common mistakes[​](#common-mistakes "Direct link to Common mistakes")

**Signal data is not in `$output`.** After a signal is received its payload is accessible via `$data.<taskName>`, not `$output`.

**The workflow times out before the signal arrives.** The default timeout is 60 seconds. Increase `metadata.timeout` for workflows that need to wait longer.

* * *

*   [Listen](https://zigflow.dev/docs/dsl/tasks/listen): full listen reference
*   [Concepts: Temporal prerequisites](https://zigflow.dev/docs/concepts/temporal-prereqs): signals, queries and updates explained