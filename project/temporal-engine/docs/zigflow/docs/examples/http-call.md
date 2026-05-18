# HTTP Call | Zigflow

> Source: [https://zigflow.dev/docs/examples/http-call](https://zigflow.dev/docs/examples/http-call)

Fetch data from an external HTTP API and store the response in workflow state.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to make an HTTP GET request from a workflow using `call: http`
*   How to capture and shape the HTTP response body
*   How to pass dynamic values to an endpoint using runtime expressions

## Workflow[​](#workflow "Direct link to Workflow")

workflow.yaml

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: fetch-user  version: 0.0.1do:  - getUser:      call: http      output:        as:          user: ${ . }      with:        method: get        endpoint: https://jsonplaceholder.typicode.com/users/1
```

## Explanation[​](#explanation "Direct link to Explanation")

The `call: http` task runs as a Temporal activity. It makes the request, then returns the response body as the task output. `output.as` maps that body into `{ "user": ... }`.

**Retry behaviour.** Failed HTTP calls (non-2xx responses) are retried using the workflow's retry policy. Wrap the call in a [`try` task](https://zigflow.dev/docs/dsl/tasks/try) to intercept specific errors.

## Passing dynamic values to the endpoint[​](#passing-dynamic-values-to-the-endpoint "Direct link to Passing dynamic values to the endpoint")

Use a runtime expression in `endpoint`:

```
with:  method: get  endpoint: >-    ${ "https://jsonplaceholder.typicode.com/users/"    + ($input.userId | tostring) }
```

The `$input` variable holds the data passed when the workflow was triggered.

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
    temporal workflow start \  --type fetch-user \  --task-queue zigflow \  --workflow-id fetch-1
    ```
    
4.  View the result:
    
    ```
    temporal workflow show --workflow-id fetch-1
    ```
    

## Expected output[​](#expected-output "Direct link to Expected output")

```
{  "user": {    "id": 1,    "name": "Leanne Graham"  }}
```

## Common mistakes[​](#common-mistakes "Direct link to Common mistakes")

**The call succeeds locally but fails in production.** Ensure the Zigflow worker process has network access to the target endpoint.

**Non-2xx responses fail the workflow.** HTTP errors raise by default. To recover, wrap the call in a `try` task. See [Error Handling](https://zigflow.dev/docs/examples/error-handling).

* * *

*   [Call](https://zigflow.dev/docs/dsl/tasks/call): full `call: http` reference
*   [Error Handling](https://zigflow.dev/docs/examples/error-handling): handling HTTP errors
*   [Concepts: error handling](https://zigflow.dev/docs/concepts/error-handling-and-retries): retry policy configuration