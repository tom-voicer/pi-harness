# Error Handling | Zigflow

> Source: [https://zigflow.dev/docs/examples/error-handling](https://zigflow.dev/docs/examples/error-handling)

Catch a failing HTTP call and continue with a fallback path instead of failing the whole workflow.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to use `try`/`catch` to intercept task failures
*   How to execute a recovery path when an error occurs
*   How to raise a structured error explicitly using `raise`

## Workflow[​](#workflow "Direct link to Workflow")

This workflow calls an endpoint that returns a 404. The `catch` block intercepts the error and sets a fallback value.

workflow.yaml

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: try-catch  version: 0.0.1do:  - user:      try:        - getUser:            call: http            with:              method: get              endpoint: https://jsonplaceholder.typicode.com/users/2000      catch:        do:          - setError:              set:                err: some error
```

## Explanation[​](#explanation "Direct link to Explanation")

Part

Purpose

`try`

Runs inner tasks as a child workflow

`catch.do`

Runs if any task inside `try` fails

`setError`

Sets a fallback value when an error is caught

**The `catch` block catches all errors.** There is no DSL-level filtering by error type. To handle different errors differently, inspect the error object inside the `catch` block.

**The `try` block runs as a child workflow.** Inner tasks are retried according to their configured retry policy before the `catch` block is entered.

## Raising errors explicitly[​](#raising-errors-explicitly "Direct link to Raising errors explicitly")

Use the `raise` task to fail a workflow with a structured error:

```
- validate:    raise:      error:        type: >-          https://serverlessworkflow.io/spec/1.0.0/errors/validation        status: 400        title: Missing required field        detail: ${ "userId is required, got: " + ($input.userId | tostring) }
```

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
    temporal workflow start \  --type try-catch \  --task-queue zigflow \  --workflow-id catch-1
    ```
    
4.  View the result:
    
    ```
    temporal workflow show --workflow-id catch-1
    ```
    

## Expected output[​](#expected-output "Direct link to Expected output")

```
{  "err": "some error"}
```

## Common mistakes[​](#common-mistakes "Direct link to Common mistakes")

**Not all retries are exhausted before `catch` runs.** The default retry policy applies inside `try`. The `catch` block only runs after all retries are exhausted.

* * *

*   [Try](https://zigflow.dev/docs/dsl/tasks/try): `try`/`catch` reference
*   [Raise](https://zigflow.dev/docs/dsl/tasks/raise): raising explicit errors
*   [Concepts: error handling](https://zigflow.dev/docs/concepts/error-handling-and-retries): retry policy and error model