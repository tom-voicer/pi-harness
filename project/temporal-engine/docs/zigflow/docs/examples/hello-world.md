# Hello World | Zigflow

> Source: [https://zigflow.dev/docs/examples/hello-world](https://zigflow.dev/docs/examples/hello-world)

A minimal workflow that sets a single value and returns it.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to structure the `document` header required by every workflow
*   How the `set` task stores values in workflow state
*   How `output.as` shapes the workflow result

## Workflow[​](#workflow "Direct link to Workflow")

workflow.yaml

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: hello-world  version: 0.0.1do:  - greet:      set:        message: Hello from Ziggy      output:        as:          data: ${ . }
```

## Explanation[​](#explanation "Direct link to Explanation")

Part

Purpose

`document.taskQueue`

Sets the Temporal task queue to `zigflow`

`document.workflowType`

Sets the Temporal workflow type to `hello-world`

`set`

Writes `message` into the workflow state

`output.as`

Shapes the return value of this task

The `set` task runs as a [Temporal side effect](https://docs.temporal.io/develop/go/side-effects), so generated values such as `${ uuid }` are determinism-safe here.

## How to run[​](#how-to-run "Direct link to How to run")

1.  Start a Temporal development server:
    
    ```
    temporal server start-dev
    ```
    
2.  Start the worker:
    
    ```
    zigflow run -f workflow.yaml
    ```
    
3.  Trigger the workflow:
    
    ```
    temporal workflow start \  --type hello-world \  --task-queue zigflow \  --workflow-id hello-1
    ```
    
4.  View the result:
    
    ```
    temporal workflow show --workflow-id hello-1
    ```
    

## Expected output[​](#expected-output "Direct link to Expected output")

```
{  "data": {    "message": "Hello from Ziggy"  }}
```

## Common mistakes[​](#common-mistakes "Direct link to Common mistakes")

**"No workers are registered for this task queue."** The `--task-queue` value must match `document.taskQueue` in the YAML file.

**"Workflow type not found."** The `--type` value must match `document.workflowType` in the YAML file.

* * *

*   [Set](https://zigflow.dev/docs/dsl/tasks/set): the task used here
*   [Quickstart](https://zigflow.dev/docs/getting-started/quickstart): guided walkthrough
*   [HTTP Call](https://zigflow.dev/docs/examples/http-call): next example