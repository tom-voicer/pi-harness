# What Are Tasks? | Zigflow

> Source: [https://zigflow.dev/docs/dsl/tasks/intro](https://zigflow.dev/docs/dsl/tasks/intro)

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   What a task is and how tasks relate to Temporal activities and workflows
*   Which task types are available
*   Common properties shared by all tasks

A task within a workflow represents a discrete unit of work that contributes to achieving the overall objectives defined by the workflow.

It encapsulates a specific action or set of actions that need to be executed in a predefined order to advance the workflow towards its completion.

Tasks are designed to be modular and focused, each serving a distinct purpose within the broader context of the workflow.

By breaking down the workflow into manageable tasks, organizations can effectively coordinate and track progress, enabling efficient collaboration and ensuring that work is completed in a structured and organized manner.

In Temporal, a task may add logic to:

*   **the workflow**: this is a deterministic piece of logic which helps progress the flow of data.
*   **an [activity](https://docs.temporal.io/activities)**: this executes a single, well-defined action, such as making an HTTP call, and may be non-deterministic.

## Available Tasks[​](#available-tasks "Direct link to Available Tasks")

Name

Description

[Call](https://zigflow.dev/docs/dsl/tasks/call)

Enables the execution of a specified function within a workflow, allowing seamless integration with custom business logic or external services.

[Do](https://zigflow.dev/docs/dsl/tasks/do)

Serves as a fundamental building block within workflows, enabling the sequential execution of multiple subtasks. By defining a series of subtasks to perform in sequence, the Do task facilitates the efficient execution of complex operations, ensuring that each subtask is completed before the next one begins.

[For](https://zigflow.dev/docs/dsl/tasks/for)

Allows workflows to iterate over a collection of items, executing a defined set of subtasks for each item in the collection. This task type is instrumental in handling scenarios such as batch processing, data transformation, and repetitive operations across datasets.

[Fork](https://zigflow.dev/docs/dsl/tasks/fork)

Allows workflows to execute multiple subtasks concurrently, enabling parallel processing and improving the overall efficiency of the workflow. By defining a set of subtasks to perform concurrently, the Fork task facilitates the execution of complex operations in parallel, ensuring that multiple tasks can be executed simultaneously.

[Listen](https://zigflow.dev/docs/dsl/tasks/listen)

Provides a mechanism for workflows to await and react to external events, enabling event-driven behavior within workflow systems.

[Raise](https://zigflow.dev/docs/dsl/tasks/raise)

Intentionally triggers and propagates errors. By employing the "Raise" task, workflows can deliberately generate error conditions, allowing for explicit error handling and fault management strategies to be implemented.

[Run](https://zigflow.dev/docs/dsl/tasks/run)

Provides the capability to execute external containers, shell commands, scripts, or workflows.

[Set](https://zigflow.dev/docs/dsl/tasks/set)

A task used to set data.

[Switch](https://zigflow.dev/docs/dsl/tasks/switch)

Enables conditional branching within workflows, allowing them to dynamically select different paths based on specified conditions or criteria

[Try](https://zigflow.dev/docs/dsl/tasks/try)

Serves as a mechanism within workflows to handle errors gracefully, potentially retrying failed tasks before proceeding with alternate ones.

[Wait](https://zigflow.dev/docs/dsl/tasks/wait)

Allows workflows to pause or delay their execution for a specified period of time.

## Runtime Expressions[​](#runtime-expressions "Direct link to Runtime Expressions")

tip

Runtime expressions use the format for [jq](https://jqlang.org/), wrapped in `${}` Underneath, this uses [gojq](https://github.com/itchyny/gojq) to parse the runtime expression. This is similar to jq, but omits some functions by design.

Please refer to this documentation as well as Zigflow.

Runtime expressions serve as dynamic elements that enable flexible and adaptable workflow behaviors. These expressions provide a means to evaluate conditions, transform data, and make decisions during the execution of workflows.

### Variables[​](#variables "Direct link to Variables")

Variables able to be referenced within runtime expressions.

Name

Description

Example

`$context`

Anything set to the output in previous steps. Typically used within [output](https://zigflow.dev/docs/dsl/intro#output) and [export](https://zigflow.dev/docs/dsl/intro#export)

`${ $context }`

`$data`

Data set to the workflow's state - see [data](#data)

`${ $data.someData }`

`$env`

Any environment variable prefixed with `ZIGGY_`. The prefix is *NOT* used in this object. This can be set with the [`--env-prefix` flag](https://zigflow.dev/docs/cli/commands/zigflow#options)

`${ $env.EXAMPLE_ENVVAR }`

`$input`

Any input received when the workflow was triggered

`${ $input.val1 }`

`$output`

Any output exported from a task - see [output](https://zigflow.dev/docs/dsl/intro#output)

`${ $output }`

### Functions[​](#functions "Direct link to Functions")

Function

Description

Example output

`${uuid}`

Generate a [UUIDv4](https://en.wikipedia.org/wiki/Universally_unique_identifier#Version_4_\(random\))

`6377413e-7a8c-4416-af5e-347a6d60e260`

`${timestamp}`

Display the current [Unix timestamp](https://en.wikipedia.org/wiki/Unix_time)

`1768584562`

`${timestamp_iso8601}`

Display the current time in [ISO8601](https://en.wikipedia.org/wiki/ISO_8601) format

`2026-01-16T17:29:22Z`

This can be further manipulated by piping the response to another `jq` function. For example, `${timestamp | strftime("%Y-%m-%d %H:%M:%S")}` would return `2026-01-16 17:29:22`.

### Data[​](#data "Direct link to Data")

The `$data` object also receives the workflow and activity info.

#### Workflow[​](#workflow "Direct link to Workflow")

This can be accessed from `${ $data.workflow }`.

*   attempt
*   binary\_checksum
*   continued\_execution\_run\_id
*   cron\_schedule
*   first\_run\_id
*   namespace
*   original\_run\_id
*   parent\_workflow\_namespace
*   priority\_key
*   task\_queue\_name
*   workflow\_execution\_id
*   workflow\_execution\_run\_id
*   workflow\_execution\_timeout
*   workflow\_start\_time
*   workflow\_type\_name

#### Activity[​](#activity "Direct link to Activity")

warning

Ideally, this should be avoided as Zigflow does not allow specific targeting of an activity.

This can be accessed from `${ $data.activity }`.

*   activity\_id
*   activity\_type\_name
*   attempt
*   deadline
*   heartbeat\_token
*   is\_local\_activity
*   priority\_key
*   schedule\_to\_close\_timeout
*   scheduled\_time
*   start\_to\_close\_timeout
*   started\_time
*   task\_queue
*   task\_token
*   workflow\_namespace
*   workflow\_execution\_id
*   workflow\_execution\_run\_id

## Flow Directive[​](#flow-directive "Direct link to Flow Directive")

Flow Directives are commands within a workflow that dictate its progression.

Directive

Description

`"continue"`

Instructs the workflow to proceed with the next task in line. This action may conclude the execution of a particular workflow or branch if there are not tasks defined after the continue one.

`"exit"`

Completes the current scope's execution, potentially terminating the entire workflow if the current task resides within the main `do` scope.

`"end"`

Provides a graceful conclusion to the workflow execution, signaling its completion explicitly.

`string`

Continues the workflow at the task with the specified name.

warning

Flow directives may only redirect to tasks declared within their own scope. In other words, they cannot target tasks at a different depth.

## Idempotency Keys[​](#idempotency-keys "Direct link to Idempotency Keys")

Temporal provides **at-least-once execution guarantees**. This means that activities may be retried automatically due to failures, timeouts or worker restarts.

As a result, any operation with side effects (such as HTTP POST requests) may run more than once.

To prevent duplicate side effects, you should use an **idempotency key** so that external systems can recognise and ignore repeated requests.

note

An idempotency key must be handled by the receiving system. Zigflow does not enforce idempotency behaviour.

### What is an idempotency key?[​](#what-is-an-idempotency-key "Direct link to What is an idempotency key?")

An idempotency key is a value that uniquely identifies a request. If the same request is received multiple times, the target system can recognise it and avoid processing it again.

### Defining an idempotency key[​](#defining-an-idempotency-key "Direct link to Defining an idempotency key")

Zigflow does not generate idempotency keys automatically. You define them explicitly based on your workflow's needs.

A simple approach is to create a unique key at runtime (for example, scoped to a single workflow execution to handle retries):

```
do:  - createIdempotencyKey:      set:        idempotencyKey: ${ uuid }
```

### Using the idempotency key[​](#using-the-idempotency-key "Direct link to Using the idempotency key")

Once defined, the key can be passed to external systems. For example:

```
do:  - callApi:      call: http      with:        method: POST        url: https://api.example.com/orders        headers:          x-idempotency-key: ${ $data.idempotencyKey }
```

The receiving service is responsible for ensuring the request is only processed once.

### Choosing the right key[​](#choosing-the-right-key "Direct link to Choosing the right key")

The effectiveness of an idempotency key depends on how it is scoped.

*   `${ uuid }`: Unique per workflow execution
*   `${ $data.workflow.workflow_execution_id }`: Stable for the workflow run
*   `${ input.orderId }`: Stable across multiple workflow executions